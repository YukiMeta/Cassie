/** Optional legacy provider workbench; the default product surface only observes agent-owned files. */
export const providerWorkbench = new URLSearchParams(location.search).get('workbench') === '1';
