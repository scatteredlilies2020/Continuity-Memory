// Compatibility entry point for installs whose cached manifest still names loader.js.
// Keep this as a static import: some SillyTavern forks cannot fetch import() modules.
import './index.js?v=0.14.0-standalone.262';
