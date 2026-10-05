export function isAskUserToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  return name === 'AskUserQuestion' || name === 'ask_user' || name.endsWith('__ask_user');
}
