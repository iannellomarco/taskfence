interface PiUi {
    notify(message: string, level?: "info" | "warning" | "error"): void;
}
interface PiExtensionContext {
    ui?: PiUi;
    sessionManager?: {
        getSessionId(): string;
        getSessionFile(): string | undefined;
    };
}
interface PiToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
}
interface PiToolResultEvent {
    type: "tool_result";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: unknown[];
    details?: unknown;
    isError: boolean;
    usage?: unknown;
}
interface PiToolCallEventResult {
    block?: boolean;
    reason?: string;
}
interface PiToolResultEventResult {
    content?: unknown[];
    details?: unknown;
    isError?: boolean;
    usage?: unknown;
}
interface PiCommandOptions {
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => Array<{
        value: string;
        label?: string;
        description?: string;
    }> | null | Promise<Array<{
        value: string;
        label?: string;
        description?: string;
    }> | null>;
    handler(args: string, context: PiExtensionContext): Promise<void>;
}
interface PiSessionStartEvent {
    type: "session_start";
    reason: "startup" | "reload" | "new" | "resume" | "fork";
    previousSessionFile?: string;
}
interface PiExtensionApi {
    on(event: "session_start", handler: (event: PiSessionStartEvent, context: PiExtensionContext) => Promise<void>): void;
    on(event: "tool_call", handler: (event: PiToolCallEvent, context: PiExtensionContext) => Promise<PiToolCallEventResult | void>): void;
    on(event: "tool_result", handler: (event: PiToolResultEvent, context: PiExtensionContext) => Promise<PiToolResultEventResult | void>): void;
    registerCommand(name: string, options: PiCommandOptions): void;
}
declare function createPiTaskFenceExtension(api: PiExtensionApi): void;

export { type PiExtensionApi, createPiTaskFenceExtension as default };
