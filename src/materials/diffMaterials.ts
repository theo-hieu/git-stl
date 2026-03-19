import { markRaw } from "vue";
import {
  DoubleSide,
  LineBasicMaterial,
  MeshBasicMaterial,
  MeshStandardMaterial,
} from "three";

const sharedDiffMaterialOptions = {
  transparent: true,
  opacity: 0.4,
  depthWrite: false,
  side: DoubleSide,
  polygonOffset: true,
  polygonOffsetFactor: -1,
  polygonOffsetUnits: -1,
} as const;

export const diffRedMaterial = markRaw(
  new MeshBasicMaterial({
    color: "#ef4444",
    ...sharedDiffMaterialOptions,
  }),
) as MeshBasicMaterial;

export const diffGreenMaterial = markRaw(
  new MeshBasicMaterial({
    color: "#22c55e",
    ...sharedDiffMaterialOptions,
  }),
) as MeshBasicMaterial;

export const diffRedEdgeMaterial = markRaw(
  new LineBasicMaterial({
    color: 0x880000,
    transparent: true,
    opacity: 0.8,
  }),
) as LineBasicMaterial;

export const diffGreenEdgeMaterial = markRaw(
  new LineBasicMaterial({
    color: 0x005500,
    transparent: true,
    opacity: 0.8,
  }),
) as LineBasicMaterial;

const sharedCsgMaterialOptions = {
  depthWrite: true,
  transparent: false,
  roughness: 0.85,
  metalness: 0.05,
  side: DoubleSide,
} as const;

export const diffCsgAddedMaterial = markRaw(
  new MeshStandardMaterial({
    color: "#22c55e",
    ...sharedCsgMaterialOptions,
  }),
) as MeshStandardMaterial;

export const diffCsgRemovedMaterial = markRaw(
  new MeshStandardMaterial({
    color: "#ef4444",
    ...sharedCsgMaterialOptions,
  }),
) as MeshStandardMaterial;

export const diffCsgUnchangedMaterial = markRaw(
  new MeshStandardMaterial({
    color: "#94a3b8",
    ...sharedCsgMaterialOptions,
  }),
) as MeshStandardMaterial;
