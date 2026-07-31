interface HookExecutionResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
declare function runClaudeHook(payload: unknown): Promise<HookExecutionResult>;

export { type HookExecutionResult, runClaudeHook };
