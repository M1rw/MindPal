/** Placeholder summaries the backend treats as empty. Do not show them as a real profile. */
const PLACEHOLDER_SUMMARIES = new Set([
  'user is building a therapeutic reflective space.',
  'user reflective context.',
]);

export function honestMemorySummary(value: string | null | undefined): string {
  const text = String(value ?? '').trim();
  if (!text || PLACEHOLDER_SUMMARIES.has(text.toLowerCase())) return '';
  return text;
}

export function summaryFromAtoms(atoms: Array<{ type?: string; category?: string; value: string }>): string {
  const grouped = new Map<string, string[]>();
  for (const atom of atoms.slice(0, 8)) {
    const text = (atom.value || '').trim();
    if (!text) continue;
    const cat = (atom.type || atom.category || 'facts').trim() || 'facts';
    const cleanCat = cat.replace(/[_\/]+/g, ' ').trim();
    const label = cleanCat.charAt(0).toUpperCase() + cleanCat.slice(1);
    const list = grouped.get(label) || [];
    if (!list.includes(text)) {
      list.push(text);
      grouped.set(label, list);
    }
  }
  if (grouped.size === 0) return '';
  const parts: string[] = [];
  for (const [category, values] of grouped.entries()) {
    parts.push(`${category}: ${values.join('; ')}`);
  }
  return parts.join('. ').slice(0, 800).trim();
}
