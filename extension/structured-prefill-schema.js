// SPDX-License-Identifier: AGPL-3.0-only
// Pure schema encoders adapted from grab990/SillyTavern openai.js, e6a427ad1.
// https://codeberg.org/grab990/SillyTavern
// Kept request-local: never uses the host global structured-prefill state.
// Unlike the chat UI, preserve straight quotes so partial JSON stays valid.

function escapeRegexForSchema(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapePrefixLiteral(str) {
  return escapeRegexForSchema(str).replace(/"/g, '(?:\\\\)*"');
}

function getStructuredPrefillPatternMode(source, model) {
  const src = String(source ?? "").toLowerCase();
  const mdl = String(model ?? "").toLowerCase();
  if (src === "claude" || src === "anthropic") return "anthropic";
  // Also detect Claude models via any source (OpenRouter, custom proxies, AWS Bedrock, etc.)
  if (mdl.includes("claude")) return "anthropic";
  return "default";
}

function isGeminiSource(source) {
  const src = String(source ?? "").toLowerCase();
  return src === "makersuite" || src === "vertexai";
}

function anyCharPattern() {
  return "(?:.|\\n)";
}

function buildSlotRegex(body, patternMode, nlToken) {
  if (!body) return "[^\\s,<>]+";
  const lower = body.toLowerCase().trim();
  const anyChar = anyCharPattern();

  // [[w:N]] or [[words:N]] or [[w:N-M]]
  let m = /^(?:w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(lower);
  if (m) {
    const a = Math.max(1, Math.min(2000, parseInt(m[1])));
    const b = m[2] != null ? Math.max(1, Math.min(2000, parseInt(m[2]))) : a;
    const min = Math.min(a, b);
    const max = Math.max(a, b);
    const wordToken = "[^\\s,<>]+[,\\.!\\?;:'\"\\)\\]\\}~-]*";
    const wordSep = "[\\t ]+";

    if (patternMode === "anthropic") {
      // Avoid {n,m} ranges - use explicit repeated optional groups
      const cap = 40;
      const cappedHi = Math.min(max, cap);
      let out = "";
      for (let i = 0; i < min; i++) {
        out += i === 0 ? wordToken : `${wordSep}${wordToken}`;
      }
      for (let i = min; i < cappedHi; i++) {
        out += `(?:${wordSep}${wordToken})?`;
      }
      if (max > cap) {
        out += `(?:${wordSep}${wordToken})*`;
      }
      return out;
    }

    const minTail = Math.max(0, min - 1);
    const maxTail = Math.max(0, max - 1);
    return `${wordToken}(?:${wordSep}${wordToken}){${minTail},${maxTail}}`;
  }

  // [[opt:a|b|c]]
  m = /^(?:opt|options)\s*:\s*(.+?)\s*$/.exec(body);
  if (m) {
    const options = m[1]
      .split(/[|,]/g)
      .map((x) => x.trim())
      .filter(Boolean);
    if (options.length > 0) return `(?:${options.map(escapeRegexForSchema).join("|")})`;
    return "[^\\s,<>]+";
  }

  // [[re:pattern]]
  m = /^(?:re|regex)\s*:\s*(.+?)\s*$/.exec(body);
  if (m) {
    let rePattern = m[1].trim();
    // Strip /.../ wrapper if present
    const reMatch = rePattern.match(/^\/(.+)\/([a-z]*)$/);
    if (reMatch) rePattern = reMatch[1];
    // Remove anchors
    rePattern = rePattern.replace(/^\^+/, "").replace(/\$+$/, "");
    if (rePattern) {
      // For anthropic mode, fall back to permissive if the regex uses unsupported features
      if (patternMode === "anthropic" && (/[{}]/.test(rePattern) || /\\S/.test(rePattern))) {
        return `${anyChar}*`;
      }
      return `(?:${rePattern})`;
    }
    return `${anyChar}*`;
  }

  // [[free]]
  if (/^free\s*$/i.test(body)) return `${anyChar}+`;

  // [[keep]] - display-only marker, matches empty
  if (/^keep\s*$/i.test(body)) return "(?:)";

  // Unknown placeholder - default to a single word token
  return "[^\\s,<>]+";
}

function buildPrefixRegex(wireTemplate, patternMode, nlToken) {
  const template = String(wireTemplate ?? "");
  const slotRe = /\[\[([^\]]+?)\]\]/g;
  let out = "";
  let last = 0;
  let m;
  while ((m = slotRe.exec(template)) !== null) {
    out += escapePrefixLiteral(template.slice(last, m.index));
    out += buildSlotRegex(m[1], patternMode, nlToken);
    last = m.index + m[0].length;
  }
  out += escapePrefixLiteral(template.slice(last));
  return out;
}

function buildGeminiStructuredPrefillSchema(prefillText, settings) {
  const normalized = prefillText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Parse the prefill into segments: literal text and slot markers
  const slotRe = /\[\[([^\]]+?)\]\]/g;
  const segments = [];
  let lastIndex = 0;
  let m;

  while ((m = slotRe.exec(normalized)) !== null) {
    // Literal text before this slot
    if (m.index > lastIndex) {
      segments.push({ type: "literal", text: normalized.slice(lastIndex, m.index) });
    }
    // The slot itself
    const body = m[1].trim();
    const lower = body.toLowerCase();
    if (/^keep$/i.test(lower)) {
      segments.push({ type: "keep" });
    } else if (/^(?:opt|options)\s*:/i.test(body)) {
      const optMatch = /^(?:opt|options)\s*:\s*(.+?)\s*$/i.exec(body);
      if (optMatch) {
        const options = optMatch[1]
          .split(/[|,]/g)
          .map((x) => x.trim())
          .filter(Boolean);
        segments.push({ type: "options", values: options.length > 0 ? options : [""] });
      }
    } else if (/^free$/i.test(lower)) {
      segments.push({ type: "free" });
    } else if (/^(?:w|words)\s*:/i.test(body)) {
      const wMatch = /^(?:w|words)\s*:\s*(\d+)(?:\s*-\s*(\d+))?\s*$/i.exec(lower);
      const min = wMatch ? parseInt(wMatch[1]) : 1;
      const max = wMatch && wMatch[2] ? parseInt(wMatch[2]) : min;
      segments.push({
        type: "words",
        min,
        max,
        description: `Fill in ${min === max ? min : `${min}-${max}`} words.`,
      });
    } else if (/^(?:re|regex)\s*:/i.test(body)) {
      // Gemini can't enforce regex — treat as free text with a hint
      segments.push({ type: "free", description: `Fill in text matching: ${body}` });
    } else {
      // Unknown slot — treat as free text
      segments.push({ type: "free" });
    }
    lastIndex = m.index + m[0].length;
  }

  // Remaining literal text after last slot
  if (lastIndex < normalized.length) {
    segments.push({ type: "literal", text: normalized.slice(lastIndex) });
  }

  // Build the JSON schema with ordered properties
  const properties = {};
  const required = [];
  const propertyOrdering = [];
  let fieldIndex = 0;

  for (const seg of segments) {
    if (seg.type === "keep") {
      // Display-only marker — skip (no schema field needed)
      continue;
    }

    const fieldName = `p${fieldIndex++}`;
    propertyOrdering.push(fieldName);
    required.push(fieldName);

    if (seg.type === "literal") {
      properties[fieldName] = {
        type: "string",
        enum: [seg.text],
      };
    } else if (seg.type === "options") {
      properties[fieldName] = {
        type: "string",
        enum: seg.values,
      };
    } else if (seg.type === "words") {
      properties[fieldName] = {
        type: "string",
        description: seg.description || "Fill in the appropriate words.",
      };
    } else if (seg.type === "free") {
      properties[fieldName] = {
        type: "string",
        description: seg.description || "Fill in the appropriate text.",
      };
    }
  }

  // Add the continuation field (free-form response after the prefill)
  const contField = `p${fieldIndex}`;
  propertyOrdering.push(contField);
  required.push(contField);
  properties[contField] = {
    type: "string",
    description: "Continue the response naturally after the prefix.",
  };

  const schemaValue = {
    type: "object",
    properties,
    required,
    propertyOrdering,
  };

  return {
    schema: {
      name: "structured_prefill",
      description:
        "Constrain output so it begins with a prefix (prefill-like) and continues with additional content.",
      strict: true,
      value: schemaValue,
    },
    forClaude: false,
    nlToken: "", // Gemini handles newlines natively — no NL token encoding needed
    isMultiField: true,
  };
}

export function buildStructuredPrefillSchema(prefillText, settings, source, model) {
  if (!prefillText || !prefillText.trim()) return null;

  const isGemini = isGeminiSource(source);

  // Gemini doesn't support regex pattern — use enum + propertyOrdering approach instead
  if (isGemini) {
    return buildGeminiStructuredPrefillSchema(prefillText, settings);
  }

  const patternMode = getStructuredPrefillPatternMode(source, model);
  const minLength = Math.max(
    1,
    Math.min(10000, Number(settings.structured_prefill_min_length) || 900),
  );
  // Detect Claude via source or model name (for proxies/custom endpoints)
  const isClaude =
    source === "claude" || model.toLowerCase().includes("claude");

  // Choose a newline token that doesn't appear in the prefill
  let nlToken = String(settings.structured_prefill_newline_token || "<NL>").trim();
  if (!nlToken || /[\r\n]/.test(nlToken)) nlToken = "<NL>";
  const normalized = prefillText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (normalized.includes(nlToken)) {
    for (let i = 2; i <= 25; i++) {
      const candidate = `<NL${i}>`;
      if (!normalized.includes(candidate)) {
        nlToken = candidate;
        break;
      }
    }
  }

  // Keep JSON prefix literals exact (including straight quotes).
  const workingText = prefillText;

  // Encode newlines as NL token
  const wireTemplate = workingText
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, nlToken);

  // Build the prefix regex
  let prefixRegex = buildPrefixRegex(wireTemplate, patternMode, nlToken);

  // Allow either the NL token or a real newline in the output (models may emit either)
  if (nlToken) {
    const escapedToken = escapeRegexForSchema(nlToken);
    prefixRegex = prefixRegex.split(escapedToken).join(`(?:${escapedToken}|\\n)`);
  }

  // Build the full pattern
  const anyChar = anyCharPattern();
  let pattern;
  if (patternMode === "anthropic") {
    // Conservative mode: no {n,m} ranges, just ensure non-empty continuation
    pattern = `^(?:${prefixRegex})${anyChar}*[^\\s]${anyChar}*$`;
  } else {
    // Standard mode: enforce minimum continuation length
    pattern = `^(?:${prefixRegex})${anyChar}{${minLength},}$`;
  }

  // Validate the pattern locally
  try {
    new RegExp(pattern);
  } catch (err) {
    console.warn("Structured prefill: invalid regex pattern, falling back to safe pattern:", err);
    pattern =
      patternMode === "anthropic"
        ? `^(?:${prefixRegex})${anyChar}*[^\\s]${anyChar}*$`
        : `^(?:${prefixRegex})${anyChar}{${minLength},}$`;
  }

  // Build the schema value (the actual JSON schema)
  const schemaValue = {
    type: "object",
    properties: {
      value: {
        type: "string",
        description:
          "Full assistant reply text. Must start with the required prefix and then continue.",
        pattern: pattern,
      },
    },
    required: ["value"],
    additionalProperties: false,
  };

  if (isClaude) {
    // For Claude: return just the schema value (used directly in output_config.format.schema)
    return { schema: schemaValue, forClaude: true, nlToken };
  } else {
    // For other providers: return a json_schema wrapper (used in response_format.json_schema)
    return {
      schema: {
        name: "structured_prefill",
        description:
          "Constrain output so it begins with a prefix (prefill-like) and continues with additional content.",
        strict: true,
        value: schemaValue,
      },
      forClaude: false,
      nlToken,
    };
  }
}
