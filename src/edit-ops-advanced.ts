import { Mat4, Vec3 } from 'playcanvas';

import { Splat } from './splat';
import { State } from './splat-state';

interface EditOp {
    name: string;
    do(): void | Promise<void>;
    undo(): void | Promise<void>;
    destroy?(): void;
}

/**
 * Operation for applying position offset to selected splats
 */
class ApplyPositionOffsetOp implements EditOp {
    name = 'applyPositionOffset';
    private splat: Splat;
    private offset: Vec3;
    private paletteMap: Map<number, number>;
    private oldPaletteIndices: number[];

    constructor(splat: Splat, offset: Vec3) {
        this.splat = splat;
        this.offset = offset.clone();

        // Snapshot the palette entries used by the current selection. Palette
        // slots are allocated in do() so undo/redo keeps the stack balanced.
        this.paletteMap = new Map<number, number>();
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        const uniqueIndices = new Set<number>();
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                uniqueIndices.add(indices[i]);
            }
        }
        this.oldPaletteIndices = Array.from(uniqueIndices);
        splat.transformTexture.unlock();
    }

    async do() {
        const { splat, offset, paletteMap, oldPaletteIndices } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        paletteMap.clear();
        let newIdx = splat.transformPalette.alloc(oldPaletteIndices.length);
        oldPaletteIndices.forEach((oldIdx) => {
            paletteMap.set(oldIdx, newIdx++);
        });

        // Update splat transform palette indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = paletteMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();

        // Update transform palette with offset
        const transform = new Mat4();
        const offsetTransform = new Mat4();
        offsetTransform.setTranslate(offset.x, offset.y, offset.z);

        paletteMap.forEach((newIdx, oldIdx) => {
            splat.transformPalette.getTransform(oldIdx, transform);
            transform.mul2(offsetTransform, transform);
            splat.transformPalette.setTransform(newIdx, transform);
        });

        await splat.updatePositions();
    }

    async undo() {
        const { splat, paletteMap } = this;
        const state = splat.splatData.getProp('state') as Uint8Array;
        const indices = splat.transformTexture.lock() as Uint16Array;

        // Invert the palette map
        const inverseMap = new Map<number, number>();
        paletteMap.forEach((newIdx, oldIdx) => {
            inverseMap.set(newIdx, oldIdx);
        });

        // Restore the original transform indices
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                indices[i] = inverseMap.get(indices[i]);
            }
        }

        splat.transformTexture.unlock();
        splat.transformPalette.free(paletteMap.size);

        await splat.updatePositions();
    }

    destroy() {
        this.splat = null;
        this.offset = null;
        this.paletteMap = null;
        this.oldPaletteIndices = null;
    }
}

/**
 * Operation for applying scale multiplier to selected splats
 */
class ApplyScaleMultiplierOp implements EditOp {
    name = 'applyScaleMultiplier';
    private splat: Splat;
    private scaleMultiplier: Vec3;
    private oldScales: Float32Array;
    private selectedIndices: Uint32Array;

    constructor(splat: Splat, scaleMultiplier: Vec3) {
        this.splat = splat;
        this.scaleMultiplier = scaleMultiplier.clone();

        // Store indices and original scales of selected splats
        const state = splat.splatData.getProp('state') as Uint8Array;
        const scale_0 = splat.splatData.getProp('scale_0') as Float32Array;
        const scale_1 = splat.splatData.getProp('scale_1') as Float32Array;
        const scale_2 = splat.splatData.getProp('scale_2') as Float32Array;

        const selected: number[] = [];
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                selected.push(i);
            }
        }

        this.selectedIndices = new Uint32Array(selected);
        this.oldScales = new Float32Array(selected.length * 3);

        for (let i = 0; i < selected.length; ++i) {
            const idx = selected[i];
            this.oldScales[i * 3 + 0] = scale_0[idx];
            this.oldScales[i * 3 + 1] = scale_1[idx];
            this.oldScales[i * 3 + 2] = scale_2[idx];
        }
    }

    async do() {
        const { splat, scaleMultiplier, selectedIndices } = this;
        const scale_0 = splat.splatData.getProp('scale_0') as Float32Array;
        const scale_1 = splat.splatData.getProp('scale_1') as Float32Array;
        const scale_2 = splat.splatData.getProp('scale_2') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            const idx = selectedIndices[i];
            if (splat.splatData.activated) {
                scale_0[idx] *= scaleMultiplier.x;
                scale_1[idx] *= scaleMultiplier.y;
                scale_2[idx] *= scaleMultiplier.z;
            } else {
                scale_0[idx] += Math.log(scaleMultiplier.x);
                scale_1[idx] += Math.log(scaleMultiplier.y);
                scale_2[idx] += Math.log(scaleMultiplier.z);
            }
        }

        splat.resource.updateTransformData(splat.splatData);
        await splat.updateSorting();
    }

    async undo() {
        const { splat, selectedIndices, oldScales } = this;
        const scale_0 = splat.splatData.getProp('scale_0') as Float32Array;
        const scale_1 = splat.splatData.getProp('scale_1') as Float32Array;
        const scale_2 = splat.splatData.getProp('scale_2') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            const idx = selectedIndices[i];
            scale_0[idx] = this.oldScales[i * 3 + 0];
            scale_1[idx] = this.oldScales[i * 3 + 1];
            scale_2[idx] = this.oldScales[i * 3 + 2];
        }

        splat.resource.updateTransformData(splat.splatData);
        await splat.updateSorting();
    }

    destroy() {
        this.splat = null;
        this.scaleMultiplier = null;
        this.oldScales = null;
        this.selectedIndices = null;
    }
}

/**
 * Operation for applying opacity multiplier to selected splats
 */
class ApplyOpacityMultiplierOp implements EditOp {
    name = 'applyOpacityMultiplier';
    private splat: Splat;
    private multiplier: number;
    private oldOpacities: Float32Array;
    private selectedIndices: Uint32Array;

    constructor(splat: Splat, multiplier: number) {
        this.splat = splat;
        this.multiplier = multiplier;

        // Store indices and original opacities of selected splats
        const state = splat.splatData.getProp('state') as Uint8Array;
        const opacity = splat.splatData.getProp('opacity') as Float32Array;

        const selected: number[] = [];
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                selected.push(i);
            }
        }

        this.selectedIndices = new Uint32Array(selected);
        this.oldOpacities = new Float32Array(selected.length);

        for (let i = 0; i < selected.length; ++i) {
            this.oldOpacities[i] = opacity[selected[i]];
        }
    }

    do() {
        const { splat, multiplier, selectedIndices } = this;
        const opacity = splat.splatData.getProp('opacity') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            const idx = selectedIndices[i];
            if (splat.splatData.activated) {
                opacity[idx] = Math.max(0, Math.min(1, opacity[idx] * multiplier));
            } else {
                const alpha = 1 / (1 + Math.exp(-opacity[idx]));
                const adjusted = Math.max(1e-6, Math.min(1 - 1e-6, alpha * multiplier));
                opacity[idx] = Math.log(adjusted / (1 - adjusted));
            }
        }

        splat.resource.updateColorData(splat.splatData);
        splat.markRenderDataDirty();
    }

    undo() {
        const { splat, selectedIndices, oldOpacities } = this;
        const opacity = splat.splatData.getProp('opacity') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            opacity[selectedIndices[i]] = oldOpacities[i];
        }

        splat.resource.updateColorData(splat.splatData);
        splat.markRenderDataDirty();
    }

    destroy() {
        this.splat = null;
        this.oldOpacities = null;
        this.selectedIndices = null;
    }
}

/**
 * Operation for applying color tint to selected splats
 */
class ApplyColorTintOp implements EditOp {
    name = 'applyColorTint';
    private splat: Splat;
    private tint: Vec3;
    private oldColors: Float32Array;
    private selectedIndices: Uint32Array;

    constructor(splat: Splat, tint: Vec3) {
        this.splat = splat;
        this.tint = tint.clone();

        // Store indices and original colors of selected splats
        const state = splat.splatData.getProp('state') as Uint8Array;
        const f_dc_0 = splat.splatData.getProp('f_dc_0') as Float32Array;
        const f_dc_1 = splat.splatData.getProp('f_dc_1') as Float32Array;
        const f_dc_2 = splat.splatData.getProp('f_dc_2') as Float32Array;

        const selected: number[] = [];
        for (let i = 0; i < state.length; ++i) {
            if (state[i] === State.selected) {
                selected.push(i);
            }
        }

        this.selectedIndices = new Uint32Array(selected);
        this.oldColors = new Float32Array(selected.length * 3);

        for (let i = 0; i < selected.length; ++i) {
            const idx = selected[i];
            this.oldColors[i * 3 + 0] = f_dc_0[idx];
            this.oldColors[i * 3 + 1] = f_dc_1[idx];
            this.oldColors[i * 3 + 2] = f_dc_2[idx];
        }
    }

    do() {
        const { splat, tint, selectedIndices } = this;
        const f_dc_0 = splat.splatData.getProp('f_dc_0') as Float32Array;
        const f_dc_1 = splat.splatData.getProp('f_dc_1') as Float32Array;
        const f_dc_2 = splat.splatData.getProp('f_dc_2') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            const idx = selectedIndices[i];
            const shC0 = 0.28209479177387814;
            f_dc_0[idx] = (Math.max(0, Math.min(1, (f_dc_0[idx] * shC0 + 0.5) * tint.x)) - 0.5) / shC0;
            f_dc_1[idx] = (Math.max(0, Math.min(1, (f_dc_1[idx] * shC0 + 0.5) * tint.y)) - 0.5) / shC0;
            f_dc_2[idx] = (Math.max(0, Math.min(1, (f_dc_2[idx] * shC0 + 0.5) * tint.z)) - 0.5) / shC0;
        }

        splat.resource.updateColorData(splat.splatData);
        splat.markRenderDataDirty();
    }

    undo() {
        const { splat, selectedIndices, oldColors } = this;
        const f_dc_0 = splat.splatData.getProp('f_dc_0') as Float32Array;
        const f_dc_1 = splat.splatData.getProp('f_dc_1') as Float32Array;
        const f_dc_2 = splat.splatData.getProp('f_dc_2') as Float32Array;

        for (let i = 0; i < selectedIndices.length; ++i) {
            const idx = selectedIndices[i];
            f_dc_0[idx] = this.oldColors[i * 3 + 0];
            f_dc_1[idx] = this.oldColors[i * 3 + 1];
            f_dc_2[idx] = this.oldColors[i * 3 + 2];
        }

        splat.resource.updateColorData(splat.splatData);
        splat.markRenderDataDirty();
    }

    destroy() {
        this.splat = null;
        this.tint = null;
        this.oldColors = null;
        this.selectedIndices = null;
    }
}

export {
    ApplyPositionOffsetOp,
    ApplyScaleMultiplierOp,
    ApplyOpacityMultiplierOp,
    ApplyColorTintOp
};
