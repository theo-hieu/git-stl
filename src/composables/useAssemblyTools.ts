import { Box3, BufferAttribute, Vector3 } from "three";
import { computed, ref } from "vue";
import { extractVertices } from "../math/extractVertices";
import { WasmEngine } from "../math/WasmEngine";
import {
  assembly,
  scaleX,
  scaleY,
  scaleZ,
  selectedAssemblyItem,
} from "../store";

function getPositionAttribute(
  geometry: { getAttribute(name: "position"): unknown },
): BufferAttribute | null {
  const attribute = geometry.getAttribute("position");
  return attribute instanceof BufferAttribute ? attribute : null;
}

const isScaling = ref(false);

export function useAssemblyTools() {
  const debugTargetName = computed(
    () => selectedAssemblyItem.value?.name ?? assembly.value[0]?.name ?? null,
  );

  async function scaleAssembly(): Promise<void> {
    if (assembly.value.length === 0 || isScaling.value) {
      return;
    }

    isScaling.value = true;

    try {
      const engine = await WasmEngine.create();
      const processedGeometries = new Set<string>();

      for (const item of assembly.value) {
        const geometryKey = item.geometry.uuid;
        if (processedGeometries.has(geometryKey)) {
          continue;
        }

        processedGeometries.add(geometryKey);
        const positionAttribute = getPositionAttribute(item.geometry);
        if (!positionAttribute || !(positionAttribute.array instanceof Float32Array)) {
          continue;
        }

        const scaled = engine.scaleVertices(
          positionAttribute.array,
          scaleX.value,
          scaleY.value,
          scaleZ.value,
        );

        positionAttribute.array.set(scaled.vertices);
        positionAttribute.needsUpdate = true;
        item.geometry.computeVertexNormals();
        item.geometry.boundingBox = new Box3(
          new Vector3(...scaled.boundingBox.min),
          new Vector3(...scaled.boundingBox.max),
        );
        item.geometry.computeBoundingSphere();

        console.log(
          `[WasmEngine] "${item.name}" bounds: min=${scaled.boundingBox.min.join(", ")} max=${scaled.boundingBox.max.join(", ")} volume=${scaled.volume}`,
        );
      }

      console.log(
        `[WasmEngine] XYZ-scale applied to ${assembly.value.length} mesh(es): X=${scaleX.value} Y=${scaleY.value} Z=${scaleZ.value}`,
      );
    } catch (error) {
      console.error("[WasmEngine] scaleAssembly failed:", error);
      alert("Wasm scale failed. Check the console for details.");
    } finally {
      isScaling.value = false;
    }
  }

  function prepareWasm(): void {
    const targetItem = selectedAssemblyItem.value ?? assembly.value[0];
    if (!targetItem) {
      return;
    }

    try {
      const vertices = extractVertices(targetItem.geometry);
      console.log(
        `Extracted ${vertices.length} vertices (${vertices.length / 3} points) from "${targetItem.name}".`,
      );
      alert(`Prepared ${vertices.length} Float32 entries for WebAssembly.`);
    } catch (error) {
      console.error("Wasm preparation failed:", error);
    }
  }

  return {
    debugTargetName,
    isScaling,
    prepareWasm,
    scaleAssembly,
  };
}
