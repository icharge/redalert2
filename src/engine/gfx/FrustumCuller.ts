import * as THREE from 'three';
import { Octree } from '@brakebein/threeoctree';
interface CullNode {
    radius: number;
    overlap?: number;
    position: THREE.Vector3;
    visible?: boolean;
    nodesIndices?: number[];
    nodesByIndex?: {
        [key: number]: CullNode;
    };
}
export class FrustumCuller {
    cull<T extends THREE.Mesh = THREE.Mesh>(octree: Octree<T>, frustum: THREE.Frustum): CullNode[] {
        const visibleNodes: CullNode[] = [];
        const BOX_KEY: unique symbol = Symbol.for('__ra2web_box');
        const traverse = (node: CullNode): void => {
            let box = (node as unknown as { [key: symbol]: THREE.Box3 | undefined })[BOX_KEY];
            if (!box) {
                const r = node.radius + (node.overlap ?? 0);
                const pos = node.position;
                box = new THREE.Box3(new THREE.Vector3(pos.x - r, pos.y - r, pos.z - r), new THREE.Vector3(pos.x + r, pos.y + r, pos.z + r));
                (node as unknown as { [key: symbol]: THREE.Box3 | undefined })[BOX_KEY] = box;
            }
            if (frustum.intersectsBox(box)) {
                node.visible = true;
                if (Array.isArray(node.nodesIndices) && node.nodesIndices.length > 0) {
                    for (const index of node.nodesIndices) {
                        const child = node.nodesByIndex?.[index];
                        if (child) {
                            traverse(child);
                        }
                    }
                }
                visibleNodes.push(node);
            }
            else {
                node.visible = false;
            }
        };
        traverse(octree.root as unknown as CullNode);
        return visibleNodes;
    }
}