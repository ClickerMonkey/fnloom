/**
 * Questions Claude asks, as forms the approval card draws (gin types) and back: the `AskUserQuestion` tool (one choice
 * field per question; a multi-select question takes a list) and an MCP server's form elicitation (its flat schema of
 * text, numbers, choices and yes/no fields, the only shapes the MCP spec lets a form ask for).
 */
import type { GinTypeDef, Json } from '@harness/core';
import { g, wireType, type GinType } from '@harness/sdk';
import { z } from 'zod';

/** The `AskUserQuestion` tool's input, as far as the form needs it. */
export const AskUserQuestionInput = z.object({
  questions: z.array(z.object({
    question: z.string(),
    header: z.string().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).min(1),
    multiSelect: z.boolean().default(false),
  })).min(1),
});
export type AskUserQuestionInput = z.infer<typeof AskUserQuestionInput>;

/** A question as a form, with how its value becomes the answer Claude reads. */
export interface QuestionForm<A> {
  readonly title: string;
  readonly text: string;
  readonly form: GinTypeDef;
  /** The form's value as Claude takes it; `undefined` when the value doesn't fit. */
  answer(value: Json): A | undefined;
}

/** The field a question's answer is in (`q1`, `q2`, …). */
const fieldOf = (index: number): string => `q${String(index + 1)}`;

/** The `AskUserQuestion` tool's questions as one form; its value becomes the tool's `answers` (question → answer). */
export function askUserQuestionForm(input: AskUserQuestionInput): QuestionForm<Record<string, string>> {
  const fields: Record<string, ReturnType<typeof g.field>> = {};
  input.questions.forEach((q, index) => {
    const choice = g.enum(q.options.map((option) => option.label));
    fields[fieldOf(index)] = g.field(q.multiSelect ? g.list(choice) : choice, { docs: q.question });
  });
  const lines = input.questions.map((q) => [
    `**${q.header ?? q.question}**${q.header === undefined ? '' : ` ${q.question}`}`,
    ...q.options.map((option) => `- ${option.label}${option.description === undefined ? '' : `: ${option.description}`}`),
  ].join('\n'));
  const first = input.questions[0];
  return {
    title: input.questions.length === 1 && first !== undefined ? `Claude asks: ${first.question}` : `Claude asks ${String(input.questions.length)} questions`,
    text: lines.join('\n\n'),
    form: wireType(g.obj(fields)),
    answer(value) {
      const given = z.record(z.string(), z.union([z.string(), z.array(z.string())])).safeParse(value);
      if (!given.success) { return undefined; }
      const answers: Record<string, string> = {};
      input.questions.forEach((q, index) => {
        const picked = given.data[fieldOf(index)];
        if (picked !== undefined) { answers[q.question] = Array.isArray(picked) ? picked.join(', ') : picked; }
      });
      return answers;
    },
  };
}

/** One property of an MCP elicitation form (the spec's primitive schema). */
const ElicitProperty = z.object({
  type: z.enum(['string', 'number', 'integer', 'boolean']).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  enum: z.array(z.string()).min(1).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  minLength: z.number().int().optional(),
  maxLength: z.number().int().optional(),
});
type ElicitProperty = z.infer<typeof ElicitProperty>;

/** An MCP elicitation's requested schema. */
export const ElicitSchema = z.object({ properties: z.record(z.string(), z.unknown()).default({}), required: z.array(z.string()).default([]) });

/** One elicitation property as a gin type; one the spec doesn't allow is taken as any value. */
function elicitType(property: ElicitProperty): GinType {
  if (property.enum !== undefined) { return g.enum(property.enum); }
  switch (property.type) {
    case 'string': return g.text({ ...(property.minLength === undefined ? {} : { minLength: property.minLength }), ...(property.maxLength === undefined ? {} : { maxLength: property.maxLength }) });
    case 'number':
    case 'integer':
      return g.num({ ...(property.type === 'integer' ? { whole: true } : {}), ...(property.minimum === undefined ? {} : { min: property.minimum }), ...(property.maximum === undefined ? {} : { max: property.maximum }) });
    case 'boolean': return g.bool();
    case undefined: return g.any();
  }
}

/** An elicitation's answer: the values the MCP spec lets a form give. */
export const ElicitContent = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]));
export type ElicitContent = z.infer<typeof ElicitContent>;

/** An MCP server's form elicitation as a form; its value is the elicitation's `content`. */
export function elicitationForm(server: string, message: string, schema: unknown): QuestionForm<ElicitContent> {
  const parsed = ElicitSchema.safeParse(schema);
  const shape = parsed.success ? parsed.data : { properties: {}, required: [] };
  const required = new Set(shape.required);
  const fields: Record<string, ReturnType<typeof g.field>> = {};
  for (const [name, raw] of Object.entries(shape.properties)) {
    const property = ElicitProperty.safeParse(raw);
    const known: ElicitProperty = property.success ? property.data : {};
    const type = elicitType(known);
    const docs = [known.title, known.description].filter((part) => part !== undefined).join(': ');
    fields[name] = g.field(required.has(name) ? type : g.optional(type), docs === '' ? {} : { docs });
  }
  return {
    title: `${server} asks: ${message.split('\n')[0] ?? message}`,
    text: message,
    form: wireType(g.obj(fields)),
    answer(value) {
      const given = ElicitContent.safeParse(value);
      return given.success ? given.data : undefined;
    },
  };
}
