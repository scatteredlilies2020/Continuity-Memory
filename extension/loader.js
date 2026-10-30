// Compatibility entry point for installs whose cached manifest still names loader.js.
// Keep this as a static import: some SillyTavern forks cannot fetch import() modules.
import './index.js?v=0.15.0-testing.32&belief-wording=4&pending-recovery=1&output-planning=1&health-status=1&provenance-recovery=1&storage-recovery=1';
