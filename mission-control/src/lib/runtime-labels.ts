export interface RuntimeDisplay {
  name: string
  description: string
  authHint: string
}

export function getLocalizedRuntimeDisplay(
  t: (key: string) => string,
  runtime: { id: string; name: string; description: string; authHint: string }
): RuntimeDisplay {
  switch (runtime.id) {
    case 'openclaw':
      return {
        name: t('runtimeOpenclawName'),
        description: t('runtimeOpenclawDescription'),
        authHint: '',
      }
    case 'hermes':
      return {
        name: t('runtimeHermesName'),
        description: t('runtimeHermesDescription'),
        authHint: '',
      }
    case 'claude':
      return {
        name: t('runtimeClaudeName'),
        description: t('runtimeClaudeDescription'),
        authHint: t('runtimeClaudeAuthHint'),
      }
    case 'codex':
      return {
        name: t('runtimeCodexName'),
        description: t('runtimeCodexDescription'),
        authHint: t('runtimeCodexAuthHint'),
      }
    default:
      return {
        name: runtime.name,
        description: runtime.description,
        authHint: runtime.authHint,
      }
  }
}
