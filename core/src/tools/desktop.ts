// Desktop vision/control tools over the pinned Cua driver (REQ-11, REQ-12).
// Every input action is bound to a fresh observation from the current driver
// generation and arbiter epoch, holds the exclusive desktop claim, passes the
// human-coexistence gate, is authorized against its classified input surface,
// and is verified with driver-side predicates declared before dispatch.
//   desktop/common.ts   services, driver call, surface probe, error mapping
//   desktop/launch.ts   app.launch
//   desktop/observe.ts  desktop.observe (app windows; attached system file panels)
//   desktop/act.ts      desktop.act (one input; target-aware authorization)
//   desktop/verify.ts   predicate and OCR verification
import { appLaunch } from './desktop/launch.ts';
import { desktopObserve } from './desktop/observe.ts';
import { desktopAct } from './desktop/act.ts';

export { appLaunch, desktopObserve, desktopAct };
export { OBSERVATION_TTL_MS, type DesktopServices, type Observation, type ObservedElement } from './desktop/common.ts';
export { PANEL_SERVICE_BUNDLE } from '../desktop/panels.ts';
export const DESKTOP_TOOLS = [appLaunch, desktopObserve, desktopAct];
