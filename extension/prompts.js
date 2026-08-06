export const IMPORTANCE_RUBRIC = `Assign importance by likely future continuity value, not writing intensity, participant fame, amount of detail, or the fact that an item was worth extracting:
1 = minor flavor or a short-lived detail with no expected later consequence.
2 = limited local context or a temporary change with modest later value.
3 = significant recurring or persistent continuity that is likely to matter again.
4 = a major turning point, durable commitment, or broad change to identity, capability, control, goals, rules, or relationships.
5 = exceptionally rare and foundational: it defines the scenario's governing premise, a core identity or rule, a central long-term objective, or an irreversible transformation of the overall situation.
Most retained items should be 2 or 3. Use 4 sparingly and reserve 5 for truly foundational continuity. Repetition or an update to an ordinary fact does not make it more important.`;

export const DEFAULT_EXTRACTION_SYSTEM_PROMPT = `You maintain long-term continuity for an open-ended roleplay or simulation sandbox.
Extract only information supported by the supplied messages. Follow the scenario's own ontology: an actor or subject may be a person, group, institution, place, object, resource, process, system, or concept. Track whatever can carry continuity in this scenario, including identity, rules, capabilities, ownership or control, quantities, conditions, relationships, intentions, decisions, events, consequences, and unresolved matters. Apply this equally to personal or social roleplay, life and management simulations, strategy, mystery, creative or educational scenarios, and unusual or non-narrative formats.
Treat stat boxes, status panels, trackers, choice menus, and formatted snapshots as evidence, not as text to preserve. Extract only useful facts or changes from them; ignore decorative formatting and repeated unchanged values. Explicit user/OOC corrections take priority. If an automatically generated status box conflicts with what actually happened in narration or dialogue, prefer the narrative event.
Chronological continuity is a primary requirement. The L1 record in sceneCapsule must preserve the chronological and causal flow of the excerpt, whether it is narration, dialogue, actions, reports, logs, turns, status updates, simulation results, or a mixture: how it opened, what happened in order, why decisions or reactions followed, meaningful changes and outcomes, transitions, and how the situation ended. Use emotionalArc for the principal overall movement in people, relationships, conditions, strategy, or the wider system; leave it empty when none exists. Do not flatten a sequence into disconnected facts. Be information-dense: opening, emotionalArc, and closing are at most one short sentence each; use at most 10 one-sentence beats; combine closely related developments; omit atmosphere, stylistic description, raw formatting, and repetition unless continuity depends on it; never quote source text at length.
Use state for replaceable values or conditions that are true at the end of the excerpt. Every state must declare a lifecycle scope and operation: scene state expires when the next L1 range advances; ongoing state remains stored until a later set or clear operation but is eligible for current-state injection only while reconfirmed by the newest L1 range. Use scene for immediate locations, activities, poses, emotions, and short-term plans. Use ongoing only for explicitly continuing injuries, possessions, assignments, constraints, or similar conditions. Never encode a predicted, scheduled, intended, or expected future occurrence as current state; preserve it as a thread or chronological plan until it happens. Reuse canonical subject and attribute wording from the supplied active-state context. Emit clear when the excerpt resolves or invalidates an ongoing state. Do not repeat a supplied state merely to keep it alive. Use facts for stable or cumulative knowledge; when one predicate has several simultaneous values, combine the complete set into one value instead of emitting competing records. Use events for notable things that happened. Use relationships for meaningful connections or dependencies between any actors or subjects. Use threads for unresolved intentions, questions, commitments, processes, tensions, risks, or goals. Reuse stable names and wording for recurring actors, attributes, relationships, and threads. Do not invent facts. Avoid duplicating the same idea in many fields.
${IMPORTANCE_RUBRIC}
The scene capsule importance rates the excerpt as a whole. Keep the scene capsule concise.`;

export const DEFAULT_RETRIEVAL_SYSTEM_PROMPT = `Expand a roleplay or simulation memory-search query. Return only JSON: {"terms":["..."]}. Include concise synonyms, aliases, roles, related actors, concrete concepts, and likely paraphrases. Do not answer the conversation. Use at most 20 short terms.`;

export const DEFAULT_INJECTION_INSTRUCTION = `Use this as relevant background continuity. Live conversation and explicit user corrections take priority. Do not mention this block.`;

export const DEFAULT_EXTRACTION_TASK_TEMPLATE = `Extract continuity memory from this chronological chat excerpt. Empty arrays are valid when nothing belongs in a category. {{detail}}
Return only one JSON object with this exact shape and all keys present:
{{schema}}

{{messages}}

{{active_states}}`;

export const DEFAULT_RETRIEVAL_QUERY_TEMPLATE = `Current conversation:
{{conversation}}`;

export const DEFAULT_ARC_SYSTEM_PROMPT = `Compress a sequence of chronological L1 records into one accurate L2 record for long-term roleplay or simulation continuity. Preserve causal order, important decisions and consequences, changes in actors, relationships, capabilities, conditions, goals, rules, or the wider system, and unresolved threads. Follow the scenario's own ontology; participants need not be people. Retain meaningful local developments without preserving raw source formatting. Remove repetition and decorative prose. Never invent events or resolve anything the source leaves open.
${IMPORTANCE_RUBRIC}
Rate the L2 interval as a whole.`;

export const DEFAULT_ARC_TASK_TEMPLATE = `Create one concise L2 record from these chronological L1 records.
Return only one JSON object with this exact shape and all keys present:
{{schema}}

{{capsules}}`;

export const DEFAULT_ERA_SYSTEM_PROMPT = `Compress a sequence of chronological L2 records into one accurate L3 record for very long roleplay or simulation continuity. Preserve the major causal progression, foundational decisions and consequences, lasting changes in actors, relationships, capabilities, conditions, goals, rules, or the wider system, and unresolved threads that survive this range. Follow the scenario's own ontology; participants need not be people. Remove repeated L2-level detail and raw source formatting. Never invent events, alter chronology, or resolve anything the sources leave open.
${IMPORTANCE_RUBRIC}
Rate the L3 interval as a whole.`;

export const DEFAULT_ERA_TASK_TEMPLATE = `Create one concise L3 record from these chronological L2 records.
Return only one JSON object with this exact shape and all keys present:
{{schema}}

{{arcs}}`;

export const PROMPT_DEFAULTS = Object.freeze({
    extractionSystemPrompt: DEFAULT_EXTRACTION_SYSTEM_PROMPT,
    extractionTaskTemplate: DEFAULT_EXTRACTION_TASK_TEMPLATE,
    retrievalSystemPrompt: DEFAULT_RETRIEVAL_SYSTEM_PROMPT,
    retrievalQueryTemplate: DEFAULT_RETRIEVAL_QUERY_TEMPLATE,
    injectionInstruction: DEFAULT_INJECTION_INSTRUCTION,
    arcSystemPrompt: DEFAULT_ARC_SYSTEM_PROMPT,
    arcTaskTemplate: DEFAULT_ARC_TASK_TEMPLATE,
    eraSystemPrompt: DEFAULT_ERA_SYSTEM_PROMPT,
    eraTaskTemplate: DEFAULT_ERA_TASK_TEMPLATE,
});

export function renderPromptTemplate(template, values, required = []) {
    let source = String(template ?? '');
    for (const name of required) {
        if (!source.includes(`{{${name}}}`)) source += `${source.trim() ? '\n\n' : ''}{{${name}}}`;
    }
    for (const [name, value] of Object.entries(values)) {
        source = source.replaceAll(`{{${name}}}`, String(value ?? ''));
    }
    return source.trim();
}
