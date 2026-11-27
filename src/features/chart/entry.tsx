// The chart's DOM page (design 7.9). The web preview's build takes entry.web.tsx instead (dev
// only); both files share the .tsx extension, so Metro never pairs a .ts native file with the web
// one and bundles the real entry on web.
export { default as ChartDom } from '~/dom/chart/ChartDom'
