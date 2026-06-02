/**
 * NexaJS v0.5.0 - A lightweight reactive framework without build steps
 * TypeScript Definitions
 * Author: Yasmany Ramos García
 * License: Apache 2.0
 */

declare module 'nexajs' {
  export interface ReactiveOptions {
    deep?: boolean;
  }

  export interface WatchOptions {
    immediate?: boolean;
    deep?: boolean;
  }

  export interface EffectRunner {
    (): any;
    deps: any[];
    cleanupFns: (() => void)[];
    disabled: boolean;
    stop(): void;
  }

  export interface ComputedRef<T = any> {
    value: T;
    _runner: EffectRunner;
  }

  export interface DirectiveContext {
    [key: string]: any;
  }

  export interface ComponentDefinition {
    template?: string;
    data?: () => Record<string, any>;
    props?: string[];
    methods?: Record<string, Function>;
    onMounted?: () => void;
    onUnmounted?: () => void;
  }

  export interface Plugin {
    (nexa: typeof Nexa, options?: any): void;
  }

  export interface NexaAPI {
    /**
     * Current version of NexaJS
     */
    version: string;

    /**
     * Initialize NexaJS on a DOM element
     * @param selector CSS selector or DOM element (default: "body")
     */
    start(selector?: string | Element): void;

    /**
     * Create a reactive proxy object
     * @param obj The object to make reactive
     * @param componentName Optional component name for debugging
     */
    reactive<T extends object>(obj: T, componentName?: string): T;

    /**
     * Create a computed property that tracks dependencies
     * @param getterFn Function that returns the computed value
     */
    computed<T>(getterFn: () => T): ComputedRef<T>;

    /**
     * Watch for changes in a reactive expression
     * @param sourceFnOrExpr Function or expression to watch
     * @param callback Callback triggered when value changes
     * @param options Watch options (immediate, deep)
     */
    watch<T>(
      sourceFnOrExpr: () => T,
      callback: (newValue: T, oldValue: T | undefined) => void,
      options?: WatchOptions
    ): EffectRunner;

    /**
     * Create an effect that tracks reactive dependencies
     * @param fn Function to execute as an effect
     */
    effect(fn: () => any): EffectRunner;

    /**
     * Evaluate an expression in a given scope
     * @param expr Expression string to evaluate
     * @param scope Scope object containing variables
     */
    evaluate(expr: string, scope: Record<string, any>): any;

    /**
     * Define a reusable component
     * @param name Component name
     * @param definition Component definition object
     */
    defineComponent(name: string, definition: ComponentDefinition): void;

    /**
     * Register a custom directive
     * @param name Directive name (without x- prefix)
     * @param handler Directive handler function
     */
    registerDirective(
      name: string,
      handler: (
        el: HTMLElement,
        expr: string,
        ctx: DirectiveContext,
        arg?: string,
        scopeNode?: Node
      ) => void
    ): void;

    /**
     * Install a plugin
     * @param plugin Plugin function
     * @param options Optional plugin options
     */
    use(plugin: Plugin, options?: any): typeof Nexa;

    /**
     * Execute a function after the next DOM update
     * @param fn Function to execute
     */
    nextTick<T>(fn?: () => T): Promise<T>;

    /**
     * Registered plugins
     */
    plugins: Array<{ plugin: Plugin; options?: any }>;
  }

  export const Nexa: NexaAPI;
  export default Nexa;
}

// Global declaration for browser usage
interface Window {
  Nexa: typeof import('nexajs').Nexa;
}

declare const Nexa: typeof import('nexajs').Nexa;
