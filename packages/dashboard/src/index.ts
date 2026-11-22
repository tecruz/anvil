/**
 * @anvil/dashboard — the optional local, read-only overview over anvil's CLI JSON.
 *
 * The package owns the HTTP surface and the snapshot reader. It depends on no anvil
 * package and no runtime library, so it can be bundled into the single-file CLI without
 * widening the distribution's dependency surface.
 */

export {
  type ActionResult,
  type ActionStage,
  actionArgv,
  actionResult,
  DASHBOARD_ACTIONS,
  type DashboardAction,
  parseAction,
} from './actions.ts'
export { CSS, HTML, JS } from './assets.ts'
export { createDashboardServer, type DashboardServerHandle, type DashboardServerOptions } from './server.ts'
export {
  type DashboardInvoke,
  type DashboardInvokeResult,
  type DashboardSnapshot,
  type DashboardSource,
  type LoadSnapshotOptions,
  loadSnapshot,
  type StagedFileView,
  type StagedView,
} from './snapshot.ts'
