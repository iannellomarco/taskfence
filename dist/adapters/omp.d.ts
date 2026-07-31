interface OmpUi {
    notify(message: string, level?: "info" | "warning" | "error"): void;
}
interface OmpExtensionContext {
    ui?: OmpUi;
    sessionManager?: {
        getSessionId(): string;
        getSessionFile(): string | undefined;
    };
}
interface OmpToolCallEvent {
    type: "tool_call";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
}
interface OmpToolResultEvent {
    type: "tool_result";
    toolCallId: string;
    toolName: string;
    input: Record<string, unknown>;
    content: unknown[];
    details?: unknown;
    isError: boolean;
}
interface OmpToolCallEventResult {
    block?: boolean;
    reason?: string;
    input?: Record<string, unknown>;
}
interface OmpToolResultEventResult {
    content?: unknown[];
    details?: unknown;
    isError?: boolean;
}
interface OmpCommandOptions {
    description?: string;
    getArgumentCompletions?: (argumentPrefix: string) => Array<{
        value: string;
        label?: string;
        description?: string;
    }> | null;
    handler(args: string, context: OmpExtensionContext): Promise<void>;
}
interface OmpSessionStartEvent {
    type: "session_start";
}
interface OmpExtensionApi {
    on(event: "session_start", handler: (event: OmpSessionStartEvent, context: OmpExtensionContext) => Promise<void>): void;
    on(event: "tool_call", handler: (event: OmpToolCallEvent, context: OmpExtensionContext) => Promise<OmpToolCallEventResult | void>): void;
    on(event: "tool_result", handler: (event: OmpToolResultEvent, context: OmpExtensionContext) => Promise<OmpToolResultEventResult | void>): void;
    registerCommand(name: string, options: OmpCommandOptions): void;
}
declare function createOmpTaskFenceExtension(api: OmpExtensionApi): void;

export { type OmpExtensionApi, createOmpTaskFenceExtension as default };
