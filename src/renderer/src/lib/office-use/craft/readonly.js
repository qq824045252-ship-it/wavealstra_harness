(() => {
  async function enableReadOnly(kind, api) {
    if (kind !== 'word') return false
    // The document lives in the engine's private session. The host never writes it
    // back for a read-only open, so this protection only applies to the current view.
    const existing = await api.execute('review.restrict', {})
    if (existing.protection) {
      return existing.protection === 'readOnly' && existing.password && existing.exceptions === 0
    }
    const permission = await api.execute('review.restrict', {
      mode: 'readOnly',
      password: crypto.randomUUID(),
    })
    return permission.protection === 'readOnly' && permission.password && permission.exceptions === 0
  }

  globalThis.enableMyBuddyCraftReadOnly = enableReadOnly
})()
