// SPDX-License-Identifier: Apache-2.0
/** The host module `@nuah/editor` provides for face.editor@1 (ADR 0095): its default export is `{ version, mount }`. */
import { mount } from "./face";
export { mount, open, modulesOf, type FaceHooks, type EditorHandle, type ElementsList } from "./face";
export { createEngine, newBlockId, type Engine, type Live } from "./engine";
export { Elements, apiFor, API_VERSION } from "./api";
export { createLoader, type ModuleEntry } from "./loader";
export default { version: "1.0.0", mount };
