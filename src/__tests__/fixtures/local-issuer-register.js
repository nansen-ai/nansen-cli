// Test-only module boundary: keep the actual device/owner code unchanged while
// admitting one loopback fixture origin. The outbound guard is preloaded first.
import { register } from 'node:module';
register('./local-issuer-loader.js', import.meta.url);
