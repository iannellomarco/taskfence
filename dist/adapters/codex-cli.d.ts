interface HookExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
declare function runCodexHook(payload: unknown): Promise<HookExecutionResult>;

export { type HookExecutionResult, runCodexHook };
