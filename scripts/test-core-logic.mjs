import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import ts from 'typescript';

const importTypeScript = async (filename) => {
    const source = await readFile(filename, 'utf8');
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ES2020,
            target: ts.ScriptTarget.ES2022
        }
    }).outputText;
    const dataUrl = `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`;
    return import(dataUrl);
};

const projectDocument = await importTypeScript(new URL('../src/project-document.ts', import.meta.url));
const ranking = await importTypeScript(new URL('../src/image-pose-match-ranking.ts', import.meta.url));
const posePresentation = await importTypeScript(new URL('../src/colmap-pose-presentation.ts', import.meta.url));
const rotationSearch = await importTypeScript(new URL('../src/image-pose-rotation-search.ts', import.meta.url));
const trajectoryFormat = await importTypeScript(new URL('../src/trajectory-export-format.ts', import.meta.url));
const cameraInput = await importTypeScript(new URL('../src/camera-input-policy.ts', import.meta.url));

const validProject = {
    splats: [{
        position: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
        tintClr: [1, 1, 1, 1]
    }],
    camera: { focalPoint: [0, 0, 0], azim: 0, elev: 0, distance: 1, fov: 60 },
    view: {
        bgColor: [0, 0, 0, 1],
        selectedColor: [1, 1, 1, 1],
        unselectedColor: [1, 1, 1, 1],
        lockedColor: [1, 1, 1, 1]
    },
    poseSets: [{ poses: [{ position: [0, 0, 1], target: [0, 0, 0], fov: 60 }] }]
};

assert.equal(cameraInput.orbitAzimuthDelta(-12, true), 12);
assert.equal(cameraInput.orbitAzimuthDelta(-12, false), -12);

const macControlPrimary = cameraInput.beginMouseGesture(0, 1, true, true);
assert.equal(macControlPrimary.physicalButton, 0);
assert.equal(macControlPrimary.navigationButton, 2);
assert.equal(macControlPrimary.controlClickAsRight, true);

const macControlSecondary = cameraInput.beginMouseGesture(2, 2, true, true);
assert.equal(macControlSecondary.physicalButton, 2);
assert.equal(macControlSecondary.navigationButton, 2);
assert.equal(macControlSecondary.controlClickAsRight, true);

const noModifiers = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
const controlModifier = { ...noModifiers, ctrlKey: true };
assert.equal(cameraInput.resolveMouseDragAction('orbit', 2, noModifiers, false, true), 'pan');
assert.equal(cameraInput.resolveMouseDragAction('orbit', 2, controlModifier, true, true), 'pan');
assert.equal(cameraInput.resolveMouseDragAction('fly', 2, noModifiers, false, true), 'pan');
assert.equal(cameraInput.mouseGestureIsActive(0, 2, true), true);
assert.equal(cameraInput.mouseGestureIsActive(0, 2, false), false);
assert.equal(cameraInput.cameraFocusEvent(true), 'click');
assert.equal(cameraInput.isCameraFocusActivation('click', 2, true), true);
assert.equal(cameraInput.isCameraFocusActivation('click', 1, true), false);
assert.equal(cameraInput.cameraFocusEvent(false), 'dblclick');
assert.equal(cameraInput.isCameraFocusActivation('dblclick', 2, false), true);

assert.equal(projectDocument.validateProjectDocument(validProject), validProject);
assert.throws(
    () => projectDocument.validateProjectDocument({ ...validProject, splats: [{ ...validProject.splats[0], scale: [1, NaN, 1] }] }),
    /malformed splat/
);
assert.throws(
    () => projectDocument.validateProjectDocument({ ...validProject, poseSets: [{ poses: [{ position: [0, 0, 1] }] }] }),
    /malformed camera pose/
);

const complete = ranking.imagePoseMatchStatistics([0.9, 0.7, 0.6], 'full', true);
assert.equal(complete.confidence, 'high');
assert.ok(complete.probability < 1);
assert.ok(complete.probability > complete.probabilities[1]);

const partial = ranking.imagePoseMatchStatistics([0.9, 0.7], 'full', false);
assert.equal(partial.confidence, 'medium');
const single = ranking.imagePoseMatchStatistics([0.9], 'full', true);
assert.equal(single.confidence, 'medium');
assert.equal(single.margin, 0);
const exact = ranking.imagePoseMatchStatistics([1], 'exact-real', false);
assert.equal(exact.confidence, 'high');
assert.ok(exact.probability <= 0.999);
const duplicateExact = ranking.imagePoseMatchStatistics([1, 1], 'exact-real', false);
assert.ok(duplicateExact.probabilities.every(probability => probability < 0.5));
assert.ok(duplicateExact.probabilities.reduce((sum, probability) => sum + probability, 0) < 1);

const identityPose = posePresentation.describeColmapW2cPose({
    qw_w2c: 1,
    qx_w2c: 0,
    qy_w2c: 0,
    qz_w2c: 0,
    tx_w2c: 1,
    ty_w2c: 2,
    tz_w2c: 3
});
assert.deepEqual(identityPose.center, [-1, -2, -3]);
assert.deepEqual(identityPose.forward, [0, 0, 1]);
assert.match(posePresentation.formatColmapPoseClipboard(identityPose), /q_w2c_wxyz=1,0,0,0/);
assert.throws(
    () => posePresentation.describeColmapW2cPose({
        qw_w2c: 0,
        qx_w2c: 0,
        qy_w2c: 0,
        qz_w2c: 0,
        tx_w2c: 0,
        ty_w2c: 0,
        tz_w2c: 0
    }),
    /zero length/
);

for (let angle = -175; angle <= 180; angle += rotationSearch.rotationStepDegrees) {
    const nearestCoarse = rotationSearch.coarseRotationAngles.reduce((best, candidate) => {
        const distance = Math.abs(rotationSearch.normalizeRotationDegrees(candidate - angle));
        const bestDistance = Math.abs(rotationSearch.normalizeRotationDegrees(best - angle));
        return distance < bestDistance ? candidate : best;
    });
    assert.ok(rotationSearch.refinedRotationAngles(nearestCoarse).includes(angle));
}

const trajectoryRows = [{
    index: 1,
    image_name: 'Virtual_Cam_000001.png',
    qw_w2c: 1,
    qx_w2c: 0,
    qy_w2c: 0,
    qz_w2c: 0,
    tx_w2c: 1,
    ty_w2c: 2,
    tz_w2c: 3
}, {
    index: 2,
    image_name: 'Virtual_Cam_000002.png',
    qw_w2c: -1,
    qx_w2c: 0,
    qy_w2c: 0,
    qz_w2c: 0,
    tx_w2c: 4,
    ty_w2c: 5,
    tz_w2c: 6
}];
const trajectoryCsv = trajectoryFormat.colmapW2cRowsToCsv(trajectoryRows);
assert.match(trajectoryCsv, /^index,image_name,qw_w2c/);
assert.match(trajectoryCsv, /2,Virtual_Cam_000002\.png,1,0,0,0,4,5,6/);
const trajectoryTxt = trajectoryFormat.colmapW2cRowsToImagesText(trajectoryRows);
assert.match(trajectoryTxt, /# Number of images: 2/);
assert.match(trajectoryTxt, /1 1 0 0 0 1 2 3 1 Virtual_Cam_000001\.png\n\n/);
assert.match(trajectoryTxt, /2 1 0 0 0 4 5 6 1 Virtual_Cam_000002\.png\n$/);
assert.throws(() => trajectoryFormat.colmapW2cRowsToImagesText(trajectoryRows, 0), /positive integer/);

const assetLoaderSource = await readFile(new URL('../src/asset-loader.ts', import.meta.url), 'utf8');
const sequenceSource = await readFile(new URL('../src/sequence.ts', import.meta.url), 'utf8');
const splatSerializeSource = await readFile(new URL('../src/splat-serialize.ts', import.meta.url), 'utf8');
const cameraSource = await readFile(new URL('../src/camera.ts', import.meta.url), 'utf8');
const controllerSource = await readFile(new URL('../src/controllers.ts', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../src/editor.ts', import.meta.url), 'utf8');
const advancedEditOpsSource = await readFile(new URL('../src/edit-ops-advanced.ts', import.meta.url), 'utf8');
const preferencesSource = await readFile(new URL('../src/preferences.ts', import.meta.url), 'utf8');
const rightToolbarSource = await readFile(new URL('../src/ui/right-toolbar.ts', import.meta.url), 'utf8');
const settingsPanelSource = await readFile(new URL('../src/ui/settings-panel.ts', import.meta.url), 'utf8');
const selectionEditPanelSource = await readFile(new URL('../src/ui/selection-edit-panel.ts', import.meta.url), 'utf8');
const blitShaderSource = await readFile(new URL('../src/shaders/blit-shader.ts', import.meta.url), 'utf8');
const renderSource = await readFile(new URL('../src/render.ts', import.meta.url), 'utf8');
const cameraParametersPanelSource = await readFile(new URL('../src/ui/camera-parameters-panel.ts', import.meta.url), 'utf8');
const imageSettingsDialogSource = await readFile(new URL('../src/ui/image-settings-dialog.ts', import.meta.url), 'utf8');
const rtxLauncherSource = await readFile(new URL('./launch-rtx.ps1', import.meta.url), 'utf8');
const rtxWatcherSource = await readFile(new URL('./watch-rtx-lifecycle.ps1', import.meta.url), 'utf8');
const macNodeLauncherSource = await readFile(new URL('./ensure-node-macos.zsh', import.meta.url), 'utf8');
const serviceWorkerSource = await readFile(new URL('../src/sw.ts', import.meta.url), 'utf8');
const calcHistogramSource = await readFile(new URL('../src/data-processor/calc-histogram.ts', import.meta.url), 'utf8');
const dataProcessorSource = await readFile(new URL('../src/data-processor/index.ts', import.meta.url), 'utf8');
const histogramUiSource = await readFile(new URL('../src/ui/histogram.ts', import.meta.url), 'utf8');
const modelLoadSource = `${assetLoaderSource}\n${sequenceSource}`;
assert.doesNotMatch(
    splatSerializeSource,
    /setFromEulerAngles\(\s*0\s*,\s*0\s*,\s*-?180\s*\)/,
    'splat serialization must not apply a hidden 180-degree Z rotation'
);
assert.match(
    controllerSource,
    /platform\.name === 'osx'[\s\S]*orbitAzimuthDelta\(dx, isMacOS\)/,
    'macOS orbit dragging must use its isolated direct-manipulation direction'
);
assert.match(
    controllerSource,
    /event\.clientX - rect\.left[\s\S]*event\.clientY - rect\.top/,
    'camera input coordinates must be relative to the canvas container, not the event target'
);
assert.match(
    controllerSource,
    /beginMouseGesture\(event\.button, event\.buttons, event\.ctrlKey, isMacOS\)[\s\S]*resolveMouseDragAction/,
    'macOS mouse buttons must be normalized before resolving their camera action'
);
assert.match(
    controllerSource,
    /camera\.pickFocalPoint\(normalizedX, normalizedY, isMacOS\)[\s\S]*cameraFocusEvent\(isMacOS\)/,
    'macOS double-click focus must use click-count activation and preserve viewing distance'
);
assert.match(
    cameraSource,
    /pickFocalPoint\(x: number, y: number, preserveDistance[\s\S]*if \(!preserveDistance\)[\s\S]*setDistance/,
    'camera focus must support changing the macOS orbit center without changing viewing distance'
);
assert.match(
    controllerSource,
    /wrap\(target, 'pointercancel', pointercancel\)[\s\S]*wrap\(target, 'lostpointercapture', pointercancel\)/,
    'camera input must clear interrupted macOS pointer gestures'
);
assert.match(
    controllerSource,
    /const clearAllKeys = \(\) => \{[\s\S]*resetMouseState\(\);[\s\S]*touches = \[\]/,
    'camera input must clear pointer gestures when a macOS window loses focus'
);
assert.match(
    controllerSource,
    /camera\.flyMoveSpace === 'view'[\s\S]*worldTransform\.getZ\(\)[\s\S]*worldTransform\.getX\(\)[\s\S]*worldTransform\.getY\(\)/,
    'view-relative fly movement must use all three current camera axes'
);
assert.match(
    controllerSource,
    /Preserve horizontal navigation on the fixed world plane[\s\S]*zAxis\.y = 0[\s\S]*xAxis\.y = 0[\s\S]*moveVec\.y \+= vertical/,
    'world-relative fly movement must preserve the existing horizontal navigation mode'
);
assert.match(
    `${editorSource}\n${preferencesSource}\n${settingsPanelSource}`,
    /camera\.setFlyMoveSpace[\s\S]*camera\.flyMoveSpace[\s\S]*isEnum\(\['world', 'view'\]\)[\s\S]*fly-move-space\.world[\s\S]*fly-move-space\.view/,
    'fly movement coordinate space must be selectable and persisted'
);
assert.match(
    rightToolbarSource,
    /right-toolbar-fly-move-space[\s\S]*camera\.setFlyMoveSpace[\s\S]*camera\.flyMoveSpace[\s\S]*aria-pressed/,
    'fly movement coordinate space must have a visible synchronized toolbar toggle'
);
assert.match(
    serviceWorkerSource,
    /networkFirst[\s\S]*\/static\/locales\/[\s\S]*fetch\(event\.request, \{ cache: 'no-store' \}\)/,
    'updated localization files must not be hidden by an installed app cache'
);
assert.doesNotMatch(
    selectionEditPanelSource,
    /class:\s*['"][^'"]*\s+[^'"]*['"]/,
    'PCUI class options with multiple classes must use an array so DOMTokenList does not throw during startup'
);
assert.match(
    advancedEditOpsSource,
    /updateTransformData\(splat\.splatData\)[\s\S]*updateColorData\(splat\.splatData\)/,
    'advanced selection edits must update the PlayCanvas GPU resource through supported APIs'
);
assert.doesNotMatch(
    advancedEditOpsSource,
    /\.updateTransforms\(|\.updateColors\(/,
    'advanced selection edits must not call removed GSplatResource methods'
);
assert.match(
    selectionEditPanelSource,
    /events\.fire\('select\.delete'\)[\s\S]*events\.fire\('select\.hide'\)[\s\S]*this\.events\.fire\('edit\.add', op\)/,
    'selection edit controls must use the editor command and undo history events'
);
assert.match(
    macNodeLauncherSource,
    /\/opt\/homebrew\/bin\/brew[\s\S]*\/usr\/local\/bin\/brew/,
    'the macOS launcher must find Homebrew from Finder on Apple Silicon and Intel Macs'
);
assert.doesNotMatch(
    macNodeLauncherSource,
    /brew upgrade[^\n]*\|\| true/,
    'the macOS launcher must not hide Homebrew upgrade failures'
);
assert.doesNotMatch(
    modelLoadSource,
    /new Splat\([^\n]*transform\.rotation/,
    'model loading must not apply the splat-transform PLY display rotation'
);
assert.match(
    splatSerializeSource,
    /mat\.copy\(splat\.entity\.getWorldTransform\(\)\)/,
    'standalone splat exports must bake only the entity world transform'
);
assert.doesNotMatch(
    `${cameraSource}\n${rightToolbarSource}`,
    /camera-flip-y|toggleFlipY|setFlipY|camera\.flipY/,
    'camera presentation orientation must not be user-switchable'
);
assert.match(
    blitShaderSource,
    /1\.0\s*-\s*texCoord\.y/,
    'the final WebGPU presentation must apply exactly one fixed Y inversion'
);
assert.match(
    cameraSource,
    /pickSplatSurfacePoint/,
    'camera focus must use the CPU surface picker'
);
assert.doesNotMatch(
    cameraSource,
    /picker\.(?:prepareDepth|readDepth)/,
    'camera focus must not run GPU-sort depth picking and synchronous texture readback'
);
assert.match(
    cameraParametersPanelSource,
    /id: 'output-image-size-preset'[\s\S]*id: 'output-image-width'[\s\S]*id: 'output-image-height'/,
    'trajectory image export must expose preset and custom PNG dimensions'
);
assert.match(
    cameraParametersPanelSource,
    /events\.invoke\('targetSize'\)[\s\S]*events\.invoke\('render\.maxTextureSize'\)/,
    'trajectory output dimensions must expose the current render size and GPU limit'
);
assert.match(
    imageSettingsDialogSource,
    /resolution\.current'\)} \(\$\{targetSize\.width\} x \$\{targetSize\.height\}\)/,
    'single-image current-size preset must show its exact pixel dimensions'
);
assert.match(
    renderSource,
    /width > maxTextureSize \|\| height > maxTextureSize/,
    'image rendering must reject dimensions above the GPU texture limit'
);
assert.match(
    renderSource,
    /camera_poses_colmap_w2c\.csv[\s\S]*camera\.colmapW2cRowsToCsv[\s\S]*camera_poses_colmap_w2c\.txt[\s\S]*camera\.colmapW2cRowsToTxt/,
    'trajectory image directories must include matching CSV and TXT pose files'
);
assert.match(
    rtxLauncherSource,
    /watch-rtx-lifecycle\.ps1[\s\S]*function Start-LifecycleWatcher[\s\S]*serverProcessId/i,
    'the RTX launcher must bind its app window to the local server lifecycle'
);
assert.match(
    rtxLauncherSource,
    /function Test-SuperSplatServerProcess[\s\S]*CommandLine -replace '\\\\', '\/'[\s\S]*scripts\/start-local\.mjs/,
    'the RTX launcher must recognize valid server commands with either Windows or POSIX path separators'
);
assert.match(
    rtxWatcherSource,
    /MainWindowHandle[\s\S]*CommandLine -replace '\\\\', '\/'[\s\S]*scripts\/start-local\.mjs[\s\S]*--port=3011[\s\S]*Stop-Process/,
    'the RTX lifecycle watcher must verify its window and server before cleanup'
);
assert.match(
    calcHistogramSource,
    /async selectByRange[\s\S]*await this\.run\(splat, mode, options\)[\s\S]*mask\[i\] = 255/,
    'histogram range selection must build its mask from the verified value-map path'
);
assert.match(
    dataProcessorSource,
    /selectByRange[\s\S]*calcHistogramImpl\.selectByRange/,
    'data processor range selection must not use the WebGPU-incompatible RGBA8 mask pass'
);
assert.match(
    histogramUiSource,
    /addEventListener\('mousedown'[\s\S]*addEventListener\('mousemove'[\s\S]*addEventListener\('mouseup'/,
    'histogram selection must retain a mouse-event fallback for macOS and embedded WebViews'
);
assert.match(
    histogramUiSource,
    /addEventListener\('click'[\s\S]*this\.events\.fire\('select'/,
    'histogram selection must support click-only activation without a pointer sequence'
);

console.log('Core logic checks passed');
