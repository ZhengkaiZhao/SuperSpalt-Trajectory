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
const rightToolbarSource = await readFile(new URL('../src/ui/right-toolbar.ts', import.meta.url), 'utf8');
const blitShaderSource = await readFile(new URL('../src/shaders/blit-shader.ts', import.meta.url), 'utf8');
const renderSource = await readFile(new URL('../src/render.ts', import.meta.url), 'utf8');
const cameraParametersPanelSource = await readFile(new URL('../src/ui/camera-parameters-panel.ts', import.meta.url), 'utf8');
const imageSettingsDialogSource = await readFile(new URL('../src/ui/image-settings-dialog.ts', import.meta.url), 'utf8');
const rtxLauncherSource = await readFile(new URL('./launch-rtx.ps1', import.meta.url), 'utf8');
const rtxWatcherSource = await readFile(new URL('./watch-rtx-lifecycle.ps1', import.meta.url), 'utf8');
const modelLoadSource = `${assetLoaderSource}\n${sequenceSource}`;
assert.doesNotMatch(
    splatSerializeSource,
    /setFromEulerAngles\(\s*0\s*,\s*0\s*,\s*-?180\s*\)/,
    'splat serialization must not apply a hidden 180-degree Z rotation'
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
    rtxLauncherSource,
    /watch-rtx-lifecycle\.ps1[\s\S]*function Start-LifecycleWatcher[\s\S]*serverProcessId/i,
    'the RTX launcher must bind its app window to the local server lifecycle'
);
assert.match(
    rtxWatcherSource,
    /MainWindowHandle[\s\S]*scripts\\start-local\.mjs[\s\S]*--port=3011[\s\S]*Stop-Process/,
    'the RTX lifecycle watcher must verify its window and server before cleanup'
);

console.log('Core logic checks passed');
