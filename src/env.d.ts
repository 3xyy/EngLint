interface ImportMetaEnv {
  /** EngLint's own extension ID, computed from extension-key.pub.txt at build time. */
  readonly WXT_EXTENSION_ID: string;
  /** Build-time switch: `WXT_GDOCS_FLAG=off` makes the Docs MAIN-world script skip setting the annotate flag (fallback testing). */
  readonly WXT_GDOCS_FLAG?: string;
  /** Build-time switch: `WXT_GDOCS_CANVAS=off` leaves Docs' canvas methods unpatched, so Docs geometry comes from the SVG rects alone. */
  readonly WXT_GDOCS_CANVAS?: string;
  /** Build-time: true in the e2e build (`ENGLINT_E2E=1`), which opens the field layers' shadow roots for Playwright. */
  readonly ENGLINT_E2E: boolean;
  /** Build-time: this build's id ('e2e' in the e2e build), also written to build-id.txt (dev self-reload). */
  readonly ENGLINT_BUILD_ID: string;
}
