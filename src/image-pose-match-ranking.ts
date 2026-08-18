type ImagePoseSearchMode = 'exact-real' | 'full';

type MatchStatistics = {
    probabilities: number[],
    probability: number,
    margin: number,
    confidence: 'high' | 'medium' | 'low'
};

const probabilityTemperature = 0.05;
const noReliableMatchScore = 0.58;

const imagePoseMatchStatistics = (
    sortedScores: number[],
    searchMode: ImagePoseSearchMode,
    completeSearch: boolean
): MatchStatistics => {
    if (sortedScores.length === 0 || !Number.isFinite(sortedScores[0])) {
        throw new Error('Image pose matching requires at least one finite score');
    }
    const bestScore = sortedScores[0];
    const weights = sortedScores.map(score => Math.exp((score - bestScore) / probabilityTemperature));
    const noMatchWeight = Math.exp((noReliableMatchScore - bestScore) / probabilityTemperature);
    const totalWeight = weights.reduce((sum, value) => sum + value, noMatchWeight);
    const probabilities = weights.map(value => value / Math.max(totalWeight, Number.EPSILON));
    const probability = Math.min(probabilities[0], 0.999);
    const margin = sortedScores.length > 1 ? bestScore - sortedScores[1] : 0;
    const confidence = searchMode === 'exact-real' ? 'high' :
        completeSearch && sortedScores.length > 1 && bestScore >= 0.72 && margin >= 0.015 ? 'high' :
            bestScore >= 0.52 ? 'medium' : 'low';

    return { probabilities, probability, margin, confidence };
};

export { imagePoseMatchStatistics };
export type { ImagePoseSearchMode, MatchStatistics };
