import { z } from "zod";

export const MAX_CONTRACT_STRING_BYTES = 64 * 1024;
export const MAX_CONTRACT_COLLECTION_ENTRIES = 10_000;
export const MAX_COMMAND_ARGUMENTS = 1_024;

const nonEmptyStringSchema = z
  .string()
  .min(1)
  .max(MAX_CONTRACT_STRING_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_CONTRACT_STRING_BYTES,
    `String exceeds ${MAX_CONTRACT_STRING_BYTES} UTF-8 bytes`,
  );

export const packageManagerSchema = z.enum([
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "none",
]);

export const commandRuleSchema = z
  .object({
    argv: z
      .array(nonEmptyStringSchema)
      .min(1)
      .max(MAX_COMMAND_ARGUMENTS),
    cwd: nonEmptyStringSchema,
  })
  .strict();

export const contractDocumentSchema = z
  .object({
    version: z.literal(1),
    write: z.array(nonEmptyStringSchema).max(MAX_CONTRACT_COLLECTION_ENTRIES),
    create: z.array(nonEmptyStringSchema).max(MAX_CONTRACT_COLLECTION_ENTRIES),
    delete: z.array(nonEmptyStringSchema).max(MAX_CONTRACT_COLLECTION_ENTRIES),
    protected: z.array(nonEmptyStringSchema).max(MAX_CONTRACT_COLLECTION_ENTRIES),
    commands: z.array(commandRuleSchema).max(MAX_CONTRACT_COLLECTION_ENTRIES),
    packageManager: packageManagerSchema,
  })
  .strict();

export type RawContractDocument = z.infer<typeof contractDocumentSchema>;
