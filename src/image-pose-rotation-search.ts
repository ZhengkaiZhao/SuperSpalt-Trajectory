const rotationStepDegrees = 5;
const coarseRotationStepDegrees = 15;

const normalizeRotationDegrees = (degrees: number) => {
    const normalized = ((degrees + 180) % 360 + 360) % 360 - 180;
    return normalized === -180 ? 180 : normalized;
};

const coarseRotationAngles = Array.from(
    { length: 360 / coarseRotationStepDegrees },
    (_, index) => normalizeRotationDegrees(index * coarseRotationStepDegrees)
);

const refinedRotationAngles = (coarseAngle: number) => (
    [-2, -1, 0, 1, 2].map(offset => normalizeRotationDegrees(
        coarseAngle + offset * rotationStepDegrees
    ))
);

export {
    coarseRotationAngles,
    normalizeRotationDegrees,
    refinedRotationAngles,
    rotationStepDegrees
};
