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

console.log('Core logic checks passed');
