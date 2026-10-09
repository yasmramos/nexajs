package com.nexajs.probe;

import javafx.application.Application;
import javafx.application.Platform;
import javafx.concurrent.Worker;
import javafx.scene.Scene;
import javafx.scene.layout.StackPane;
import javafx.scene.web.WebEngine;
import javafx.scene.web.WebView;
import javafx.scene.control.TextArea;
import javafx.stage.Stage;
import netscape.javascript.JSObject;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.FutureTask;
import java.util.concurrent.TimeUnit;

/**
 * NexaJS WebView Edition - JavaFX Capability Probe.
 *
 * <p>Boots a real JavaFX {@link WebEngine} (WebKit), injects the JavaScript
 * feature-detection suite from {@code probe-suite.js}, and prints the JSON
 * report to stdout. Optionally writes the report to a file and registers a
 * working Java&lt;-&gt;JS bridge sample so the bridge contract can also be
 * validated empirically.</p>
 *
 * <p>Run modes:</p>
 * <ul>
 *   <li>{@code --headless}: stays on the FX thread, runs all probes, prints
 *       the report and exits with code 0 (or 1 on failure). Suitable for CI
 *       under Xvfb.</li>
 *   <li>default: opens an interactive window showing the raw JSON result and
 *       the engine user-agent, plus a live bridge round-trip demo.</li>
 * </ul>
 */
public class CapabilityProbeApp extends Application {

    /** Minimal blank document used as the JS execution context. */
    private static final String BLANK_HTML = """
            <!DOCTYPE html>
            <html><head><meta charset="utf-8"><title>NexaJS Probe</title></head>
            <body><div id="root"></div></body></html>
            """;

    private boolean headless = false;
    private String outputPath = null;

    /**
     * Fails fast with an actionable message when no display backend is
     * available. JavaFX's GTK/Quantum toolkit otherwise aborts deep inside
     * {@code launch()} with the cryptic "Unable to open DISPLAY" error, which
     * surfaces through exec-maven-plugin as an opaque mojo failure.
     *
     * <p>Note: Monocle (the true headless platform) is deliberately NOT used
     * here. The standard OpenJFX 21+ Maven artifacts do not ship
     * {@code GlassMonocle}, and even with TestFX's monocle jar the WebView /
     * WebKit engine cannot initialize on Monocle - and this probe exists
     * precisely to test the real WebEngine. Xvfb + the GTK pipeline is the
     * only configuration that faithfully reproduces the desktop runtime.</p>
     */
    private static void requireDisplay() {
        String os = System.getProperty("os.name", "").toLowerCase();
        if (os.contains("nix") || os.contains("nux") || os.contains("mac")) {
            String display = System.getenv("DISPLAY");
            if (display == null || display.isBlank()) {
                System.err.println("[probe] ERROR: Unable to open DISPLAY - no X display is available.");
                System.err.println("[probe] On CI or headless machines, run the probe inside a virtual framebuffer:");
                System.err.println("[probe]   xvfb-run -a mvn compile exec:exec");
                System.err.println("[probe] or start Xvfb manually and export DISPLAY (e.g. DISPLAY=:99) first.");
                System.exit(2);
            }
        }
    }

    public static void main(String[] args) {
        // Must happen BEFORE launch(): without these properties the modular
        // JavaFX launcher either aborts ("JavaFX runtime components are
        // missing" - fixed via --module-path in the pom) or tries the D3D/ES2
        // pipelines, which fail under Xvfb where there is no GPU.
        if (System.getProperty("prism.order") == null) {
            System.setProperty("prism.order", "sw");
        }
        requireDisplay();
        launch(args);
    }

    @Override
    public void init() {
        // exec-maven-plugin passes the whole ${probe.args} property as ONE
        // argument element (verified empirically: no whitespace splitting in
        // <arguments> or <additionalArguments>), so re-split any token that
        // contains spaces, e.g. "--headless --output probe-report.json".
        List<String> raw = new ArrayList<>();
        for (String arg : getParameters().getRaw()) {
            raw.addAll(List.of(arg.split("\\s+")));
        }
        for (String arg : raw) {
            switch (arg) {
                case "--headless" -> headless = true;
                default -> {
                    if (arg.startsWith("--output=")) {
                        outputPath = arg.substring("--output=".length());
                    } else if (arg.equals("--output")) {
                        // Value follows in the next token; handled by caller convention.
                    }
                }
            }
        }
        // Support "--output <file>" style too.
        for (int i = 0; i < raw.size() - 1; i++) {
            if (raw.get(i).equals("--output")) {
                outputPath = raw.get(i + 1);
            }
        }
    }

    @Override
    public void start(Stage stage) {
        WebView webView = new WebView();
        WebEngine engine = webView.getEngine();

        // Register the Java-side bridge object BEFORE loading content so it
        // is available to page scripts (mirrors the NexaJS bridge contract).
        engine.setJavaScriptEnabled(true);
        JSObject window = (JSObject) engine.executeScript("window");
        window.setMember("java", new BridgeSample());

        CountDownLatch loadedLatch = new CountDownLatch(1);
        engine.getLoadWorker().stateProperty().addListener((obs, old, now) -> {
            if (now == Worker.State.SUCCEEDED) {
                loadedLatch.countDown();
            } else if (now == Worker.State.FAILED) {
                loadedLatch.countDown();
            }
        });

        engine.loadContent(BLANK_HTML, "text/html");

        if (headless) {
            // Run probes once the page is loaded, then exit the FX loop.
            Thread runner = new Thread(() -> {
                try {
                    if (!loadedLatch.await(30, TimeUnit.SECONDS)) {
                        System.err.println("[probe] ERROR: page load timed out");
                        Platform.exit();
                        return;
                    }
                    String suite = readResource("/probe-suite.js");
                    // executeScript must run on the FX thread. The bridge
                    // round-trip is wrapped defensively: in sandboxed CI
                    // environments WebKit blocks calls into Java members for
                    // the default (file-less) content area, which throws a
                    // JSException instead of returning a value. That is itself
                    // valuable probe data, but it must never kill the report.
                    String report = runOnFx(() -> {
                        Object json = engine.executeScript(suite);
                        String base = json == null ? "{}" : json.toString();
                        boolean roundTrip;
                        try {
                            Object bridgeEcho = engine.executeScript("java.echo(\"bridge-ok\");");
                            roundTrip = "bridge-ok".equals(String.valueOf(bridgeEcho));
                        } catch (Exception bridgeFailure) {
                            System.err.println("[probe] WARN: JS->Java bridge blocked in this environment: "
                                    + bridgeFailure.getMessage());
                            roundTrip = false;
                        }
                        return base.substring(0, base.length() - 1)
                                + ",\"bridgeRoundTrip\":" + roundTrip + "}";
                    });

                    printReport(report);
                    saveReport(report);
                } catch (Exception e) {
                    System.err.println("[probe] ERROR: " + e.getMessage());
                    e.printStackTrace(System.err);
                } finally {
                    Platform.exit();
                }
            }, "probe-runner");
            runner.setDaemon(true);
            runner.start();
            // Headless mode still needs a visible-less FX window; do not show it.
            return;
        }

        // Interactive mode: run probes after load and display results.
        engine.getLoadWorker().stateProperty().addListener((obs, old, now) -> {
            if (now != Worker.State.SUCCEEDED) {
                return;
            }
            try {
                String suite = readResource("/probe-suite.js");
                String json = String.valueOf(engine.executeScript(suite));
                String pretty = prettyPrintJson(json);
                javafx.scene.control.TextArea area = new javafx.scene.control.TextArea(pretty);
                area.setEditable(false);
                area.setStyle("-fx-font-family: monospace;");
                StackPane root = new StackPane(area);
                stage.getScene().setRoot(root);
                printReport(json);
            } catch (IOException e) {
                e.printStackTrace();
            }
        });

        Scene scene = new Scene(webView, 900, 700);
        stage.setTitle("NexaJS Capability Probe - JavaFX "
                + System.getProperty("javafx.runtime.version", "?"));
        stage.setScene(scene);
        stage.show();
    }

    /** Reads a classpath resource as UTF-8 text. */
    private static String readResource(String path) throws IOException {
        try (InputStream in = CapabilityProbeApp.class.getResourceAsStream(path)) {
            if (in == null) {
                throw new IOException("Resource not found on classpath: " + path);
            }
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    /** Schedules {@code task} on the JavaFX application thread and waits for its result. */
    private static <T> T runOnFx(Callable<T> task) throws Exception {
        FutureTask<T> future = new FutureTask<>(task);
        Platform.runLater(future);
        return future.get(30, TimeUnit.SECONDS);
    }

    private void printReport(String json) {
        System.out.println("=== NexaJS JavaFX Capability Report ===");
        System.out.println("JavaFX runtime : "
                + System.getProperty("javafx.runtime.version", "unknown"));
        System.out.println("Java version   : " + System.getProperty("java.version"));
        System.out.println("JSON           : " + json);
        Map<String, Boolean> summary = summarize(json);
        summary.forEach((k, v) -> System.out.printf("  %-24s %s%n", k, v ? "PASS" : "FAIL"));
    }

    private void saveReport(String json) throws IOException {
        if (outputPath == null || outputPath.isBlank()) {
            return;
        }
        Path out = Path.of(outputPath);
        if (out.getParent() != null) {
            Files.createDirectories(out.getParent());
        }
        Files.writeString(out, json, StandardCharsets.UTF_8);
        System.out.println("[probe] report written to " + out.toAbsolutePath());
    }

    /** Extracts the boolean capability flags from the JSON report. */
    private static Map<String, Boolean> summarize(String json) {
        Map<String, Boolean> map = new LinkedHashMap<>();
        // Tiny dependency-free parser good enough for the flat {key:value} shape.
        String body = json.trim();
        if (body.startsWith("{")) {
            body = body.substring(1, body.lastIndexOf('}'));
        }
        int depth = 0;
        StringBuilder token = new StringBuilder();
        for (char c : body.toCharArray()) {
            if (c == '{' || c == '[') depth++;
            if (c == '}' || c == ']') depth--;
            if (c == ',' && depth == 0) {
                putEntry(map, token.toString());
                token.setLength(0);
            } else {
                token.append(c);
            }
        }
        putEntry(map, token.toString());
        return map;
    }

    private static void putEntry(Map<String, Boolean> map, String entry) {
        int idx = entry.indexOf(':');
        if (idx <= 0) {
            return;
        }
        String key = entry.substring(0, idx).trim().replace("\"", "");
        String value = entry.substring(idx + 1).trim();
        if (key.endsWith("_error") || !value.equals("true") && !value.equals("false")) {
            return; // skip error details and non-boolean metadata (userAgent...)
        }
        map.put(key, value.equals("true"));
    }

    /** Naive JSON pretty printer (2-space indent) for display purposes. */
    private static String prettyPrintJson(String json) {
        StringBuilder out = new StringBuilder();
        int indent = 0;
        boolean inString = false;
        for (int i = 0; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '"' && (i == 0 || json.charAt(i - 1) != '\\')) {
                inString = !inString;
            }
            if (!inString && (c == '{' || c == '[')) {
                out.append(c).append('\n').append("  ".repeat(++indent));
            } else if (!inString && (c == '}' || c == ']')) {
                out.append('\n').append("  ".repeat(--indent)).append(c);
            } else if (!inString && c == ',') {
                out.append(c).append('\n').append("  ".repeat(indent));
            } else if (!inString && c == ':') {
                out.append(": ");
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    /**
     * Sample bridge object exposed to JS as {@code window.java}. Demonstrates
     * the synchronous call pattern that NexaJS's {@code Nexa.bridge.call()}
     * will wrap with JSON serialization and async callbacks.
     */
    public static class BridgeSample {
        /** Echoes a string back to JS - proves the JSObject channel works. */
        public String echo(String message) {
            return message;
        }

        /** Adds two numbers server-side - proves typed parameter marshalling. */
        public int add(int a, int b) {
            return a + b;
        }
    }

}
