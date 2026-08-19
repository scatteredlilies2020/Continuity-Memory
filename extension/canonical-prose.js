const FIRST_OR_SECOND_PERSON = /\b(?:[Ii]|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e|[Uu]s|[Oo]ur|[Oo]urs|[Oo]urselves|[Yy]ou|[Yy]our|[Yy]ours|[Yy]ourself|[Yy]ourselves)\b/u;

export function canonicalProseIsThirdPerson(value) {
    return !FIRST_OR_SECOND_PERSON.test(String(value ?? ''));
}

export function thirdPersonOnlyProse(value) {
    const source = String(value ?? '').replace(/\s+/gu, ' ').trim();
    if (!source || canonicalProseIsThirdPerson(source)) return source;
    return source
        .split(/(?<=[.!?;])\s+/u)
        .filter(part => canonicalProseIsThirdPerson(part))
        .join(' ')
        .trim();
}
