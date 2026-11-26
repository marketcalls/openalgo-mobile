// Every chunk the openalgo-charts widget loads lazily, imported up front, so the chart's DOM
// bundle has no async chunk (design 7.7 Bundles). An Expo DOM export renames a page's chunk files
// but keeps their old names in each chunk's requires, and the widget's dialogs share one chunk
// (grid-bar), so an async chunk ends the export with "Asset not found" (the spike's finding,
// spike/app/src/dom/chart/eagerChunks.ts). A static import puts the module in the page's one
// bundle, where the widget's own dynamic import of it resolves. The paths are relative because the
// hashed files are not in the package's exports.
//
// Tied to openalgo-charts 2.7.3 (scripts/lib/pins.mjs): scripts/eager-chunks.test.mjs fails when
// the widget's lazy chunks and this list differ.
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.chart-data-export-dialog-we0VDywF.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.chart-type-settings-DYCCD4Ax.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.grid-bar-CWfujvFQ.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.grid-menus-Ujc8dpxO.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.keymap-editor-Uozy6qFE.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.layouts-menu-B7XYKPAW.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.layouts-templates-menu-DPPa9Cn1.mjs'
import '../../../node_modules/openalgo-charts/dist/openalgo-charts.widget.storage-idb-JzCQh1Se.mjs'
