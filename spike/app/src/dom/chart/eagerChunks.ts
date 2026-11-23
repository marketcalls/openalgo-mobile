// THROWAWAY SPIKE. Load every lazily imported openalgo-charts module up front so the
// DOM bundle has no async chunks. Reason: `expo export --platform android` renames DOM
// chunk files to md5 names but keeps the old names in each chunk's `requires`, and the
// widget's lazy dialogs share grid-bar, which produces a `__common-*.js` chunk; the HTML
// serializer then fails with "Asset not found: _expo/static/js/web/__common-<hash>.js".
// Importing a module statically puts it in the entry chunk, so its import() resolves
// in-bundle. Cost: about 63 KB of widget dialogs parsed at open (the indicators tier is
// needed before the first paint anyway). Paths are relative on purpose: the hashed
// files are not in the package's "exports". Pinned to openalgo-charts@2.7.3.
import 'openalgo-charts/indicators';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.chart-data-export-dialog-we0VDywF.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.chart-type-settings-DYCCD4Ax.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.grid-bar-CWfujvFQ.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.grid-menus-Ujc8dpxO.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.keymap-editor-Uozy6qFE.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.layouts-menu-B7XYKPAW.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.layouts-templates-menu-DPPa9Cn1.mjs';
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.storage-idb-JzCQh1Se.mjs';
