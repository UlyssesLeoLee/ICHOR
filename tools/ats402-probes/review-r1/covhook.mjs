// Review-only helper: flush V8 coverage periodically so a child bridge that is
// killed (TerminateProcess on Windows) still leaves its coverage on disk.
import v8 from 'node:v8';
if (process.env.NODE_V8_COVERAGE) setInterval(() => { try { v8.takeCoverage(); } catch {} }, 100).unref();
