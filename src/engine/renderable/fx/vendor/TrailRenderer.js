import {
    Object3D,
    Vector3,
    Vector2,
    Vector4,
    Quaternion,
    Matrix3,
    Matrix4,
    BufferAttribute,
    BufferGeometry,
    Mesh,
    ShaderMaterial,
    DoubleSide,
    AddEquation,
    SrcAlphaFactor,
    OneMinusSrcAlphaFactor,
    CustomBlending,
    DynamicDrawUsage,
} from 'three';

// TrailRenderer: faithful port of upstream lib/three/TrailRenderer.js adapted to three r183.
export class TrailRenderer extends Object3D {

    constructor( scene, orientToMovement ) {
        super();
        this.active = false;
        this.orientToMovement = false;
        if ( orientToMovement ) this.orientToMovement = true;
        this.scene = scene;
        this.geometry = null;
        this.mesh = null;
        this.nodeCenters = null;
        this.lastNodeCenter = null;
        this.currentNodeCenter = null;
        this.lastOrientationDir = null;
        this.nodeIDs = null;
        this.currentLength = 0;
        this.currentEnd = 0;
        this.currentNodeID = 0;
        this.isActive = false;
        this.material = null;
        this.length = 0;
        this.dragTexture = 0;
        this.targetObject = null;
        this.localHeadGeometry = [];
        this.VerticesPerNode = 0;
        this.FacesPerNode = 0;
        this.FaceIndicesPerNode = 0;
        this.vertexCount = 0;
        this.faceCount = 0;
    }

    initialize( material, length, dragTexture, localHeadWidth, localHeadGeometry, targetObject ) {
        this.deactivate();
        this.destroyMesh();

        this.length = ( length > 0 ) ? length + 1 : 0;
        this.dragTexture = ( ! dragTexture ) ? 0 : 1;
        this.targetObject = targetObject;

        this.initializeLocalHeadGeometry( localHeadWidth, localHeadGeometry );

        this.nodeIDs = [];
        this.nodeCenters = [];

        for ( let i = 0; i < this.length; i ++ ) {
            this.nodeIDs[ i ] = -1;
            this.nodeCenters[ i ] = new Vector3();
        }

        this.material = material;

        this.initializeGeometry();
        this.initializeMesh();

        this.material.uniforms.trailLength.value = 0;
        this.material.uniforms.minID.value = 0;
        this.material.uniforms.maxID.value = 0;
        this.material.uniforms.dragTexture.value = this.dragTexture;
        this.material.uniforms.maxTrailLength.value = this.length;
        this.material.uniforms.verticesPerNode.value = this.VerticesPerNode;
        this.material.uniforms.textureTileFactor.value = new Vector2( 1.0, 1.0 );

        this.reset();
    }

    initializeLocalHeadGeometry( localHeadWidth, localHeadGeometry ) {
        this.localHeadGeometry = [];

        if ( ! localHeadGeometry ) {
            let halfWidth = localHeadWidth || 1.0;
            halfWidth = halfWidth / 2.0;
            this.localHeadGeometry.push( new Vector3( - halfWidth, 0, 0 ) );
            this.localHeadGeometry.push( new Vector3( halfWidth, 0, 0 ) );
            this.VerticesPerNode = 2;
        } else {
            this.VerticesPerNode = 0;
            for ( let i = 0; i < localHeadGeometry.length && i < TrailRenderer.MaxHeadVertices; i ++ ) {
                const vertex = localHeadGeometry[ i ];
                if ( vertex && vertex instanceof Vector3 ) {
                    const vertexCopy = new Vector3();
                    vertexCopy.copy( vertex );
                    this.localHeadGeometry.push( vertexCopy );
                    this.VerticesPerNode ++;
                }
            }
        }

        this.FacesPerNode = ( this.VerticesPerNode - 1 ) * 2;
        this.FaceIndicesPerNode = this.FacesPerNode * 3;
    }

    initializeGeometry() {
        this.vertexCount = this.length * this.VerticesPerNode;
        this.faceCount = this.length * this.FacesPerNode;

        const geometry = new BufferGeometry();

        const nodeIDs = new Float32Array( this.vertexCount );
        const nodeVertexIDs = new Float32Array( this.vertexCount * this.VerticesPerNode );
        const positions = new Float32Array( this.vertexCount * TrailRenderer.PositionComponentCount );
        const nodeCenters = new Float32Array( this.vertexCount * TrailRenderer.PositionComponentCount );
        const uvs = new Float32Array( this.vertexCount * TrailRenderer.UVComponentCount );
        const indices = new Uint32Array( this.faceCount * TrailRenderer.IndicesPerFace );

        const nodeIDAttribute = new BufferAttribute( nodeIDs, 1 );
        nodeIDAttribute.setUsage( DynamicDrawUsage );
        geometry.setAttribute( 'nodeID', nodeIDAttribute );

        const nodeVertexIDAttribute = new BufferAttribute( nodeVertexIDs, 1 );
        nodeVertexIDAttribute.setUsage( DynamicDrawUsage );
        geometry.setAttribute( 'nodeVertexID', nodeVertexIDAttribute );

        const nodeCenterAttribute = new BufferAttribute( nodeCenters, TrailRenderer.PositionComponentCount );
        nodeCenterAttribute.setUsage( DynamicDrawUsage );
        geometry.setAttribute( 'nodeCenter', nodeCenterAttribute );

        const positionAttribute = new BufferAttribute( positions, TrailRenderer.PositionComponentCount );
        positionAttribute.setUsage( DynamicDrawUsage );
        geometry.setAttribute( 'position', positionAttribute );

        const uvAttribute = new BufferAttribute( uvs, TrailRenderer.UVComponentCount );
        uvAttribute.setUsage( DynamicDrawUsage );
        geometry.setAttribute( 'uv', uvAttribute );

        const indexAttribute = new BufferAttribute( indices, 1 );
        indexAttribute.setUsage( DynamicDrawUsage );
        geometry.setIndex( indexAttribute );

        this.geometry = geometry;
    }

    zeroVertices() {
        const positions = this.geometry.getAttribute( 'position' );
        for ( let i = 0; i < this.vertexCount; i ++ ) {
            const index = i * 3;
            positions.array[ index ] = 0;
            positions.array[ index + 1 ] = 0;
            positions.array[ index + 2 ] = 0;
        }
        positions.needsUpdate = true;
    }

    zeroIndices() {
        const indices = this.geometry.getIndex();
        for ( let i = 0; i < this.faceCount; i ++ ) {
            const index = i * 3;
            indices.array[ index ] = 0;
            indices.array[ index + 1 ] = 0;
            indices.array[ index + 2 ] = 0;
        }
        indices.needsUpdate = true;
    }

    formInitialFaces() {
        this.zeroIndices();
        const indices = this.geometry.getIndex();
        for ( let i = 0; i < this.length - 1; i ++ ) {
            this.connectNodes( i, i + 1 );
        }
        indices.needsUpdate = true;
    }

    initializeMesh() {
        this.mesh = new Mesh( this.geometry, this.material );
        this.mesh.matrixAutoUpdate = false;
    }

    destroyMesh() {
        if ( this.mesh ) {
            this.scene.remove( this.mesh );
            this.mesh = null;
        }
    }

    reset() {
        this.currentLength = 0;
        this.currentEnd = -1;
        this.lastNodeCenter = null;
        this.currentNodeCenter = null;
        this.lastOrientationDir = null;
        this.currentNodeID = 0;
        this.formInitialFaces();
        this.zeroVertices();
        this.geometry.setDrawRange( 0, 0 );
    }

    updateUniforms() {
        if ( this.currentLength < this.length ) {
            this.material.uniforms.minID.value = 0;
        } else {
            this.material.uniforms.minID.value = this.currentNodeID - this.length;
        }
        this.material.uniforms.maxID.value = this.currentNodeID;
        this.material.uniforms.trailLength.value = this.currentLength;
        this.material.uniforms.maxTrailLength.value = this.length;
        this.material.uniforms.verticesPerNode.value = this.VerticesPerNode;
    }

    advance() {
        const tempMatrix4 = new Matrix4();
        this.targetObject.updateMatrixWorld();
        tempMatrix4.copy( this.targetObject.matrixWorld );
        this.advanceWithTransform( tempMatrix4 );
        this.updateUniforms();
    }

    advanceWithPositionAndOrientation( nextPosition, orientationTangent ) {
        this.advanceGeometry( { position: nextPosition, tangent: orientationTangent }, null );
    }

    advanceWithTransform( transformMatrix ) {
        this.advanceGeometry( null, transformMatrix );
    }

    advanceGeometry( positionAndOrientation, transformMatrix ) {
        const nextIndex = this.currentEnd + 1 >= this.length ? 0 : this.currentEnd + 1;

        if ( transformMatrix ) {
            this.updateNodePositionsFromTransformMatrix( nextIndex, transformMatrix );
        } else {
            this.updateNodePositionsFromOrientationTangent( nextIndex, positionAndOrientation.position, positionAndOrientation.tangent );
        }

        if ( this.currentLength >= 1 ) {
            this.connectNodes( this.currentEnd, nextIndex );
            if ( this.currentLength >= this.length ) {
                const disconnectIndex = this.currentEnd + 1 >= this.length ? 0 : this.currentEnd + 1;
                this.disconnectNodes( disconnectIndex );
            }
        }

        if ( this.currentLength < this.length ) {
            this.currentLength ++;
        }

        this.currentEnd ++;
        if ( this.currentEnd >= this.length ) {
            this.currentEnd = 0;
        }

        if ( this.currentLength >= 1 ) {
            if ( this.currentLength < this.length ) {
                this.geometry.setDrawRange( 0, ( this.currentLength - 1 ) * this.FaceIndicesPerNode );
            } else {
                this.geometry.setDrawRange( 0, this.currentLength * this.FaceIndicesPerNode );
            }
        }

        this.updateNodeID( this.currentEnd, this.currentNodeID );
        this.currentNodeID ++;
    }

    updateHead() {
        const tempMatrix4 = new Matrix4();
        if ( this.currentEnd < 0 ) return;
        this.targetObject.updateMatrixWorld();
        tempMatrix4.copy( this.targetObject.matrixWorld );
        this.updateNodePositionsFromTransformMatrix( this.currentEnd, tempMatrix4 );
    }

    updateNodeID( nodeIndex, id ) {
        this.nodeIDs[ nodeIndex ] = id;

        const nodeIDs = this.geometry.getAttribute( 'nodeID' );
        const nodeVertexIDs = this.geometry.getAttribute( 'nodeVertexID' );

        for ( let i = 0; i < this.VerticesPerNode; i ++ ) {
            const baseIndex = nodeIndex * this.VerticesPerNode + i;
            nodeIDs.array[ baseIndex ] = id;
            nodeVertexIDs.array[ baseIndex ] = i;
        }

        nodeIDs.needsUpdate = true;
        nodeVertexIDs.needsUpdate = true;
    }

    updateNodeCenter( nodeIndex, nodeCenter ) {
        this.lastNodeCenter = this.currentNodeCenter;
        this.currentNodeCenter = this.nodeCenters[ nodeIndex ];
        this.currentNodeCenter.copy( nodeCenter );

        const nodeCenters = this.geometry.getAttribute( 'nodeCenter' );
        for ( let i = 0; i < this.VerticesPerNode; i ++ ) {
            const baseIndex = ( nodeIndex * this.VerticesPerNode + i ) * 3;
            nodeCenters.array[ baseIndex ] = nodeCenter.x;
            nodeCenters.array[ baseIndex + 1 ] = nodeCenter.y;
            nodeCenters.array[ baseIndex + 2 ] = nodeCenter.z;
        }
        nodeCenters.needsUpdate = true;
    }

    updateNodePositionsFromOrientationTangent( nodeIndex, nodeCenter, orientationTangent ) {
        const positions = this.geometry.getAttribute( 'position' );

        this.updateNodeCenter( nodeIndex, nodeCenter );

        const tempOffset = nodeCenter.clone().sub( TrailRenderer.LocalHeadOrigin );
        const tempQuaternion = new Quaternion().setFromUnitVectors( TrailRenderer.LocalOrientationTangent, orientationTangent );

        for ( let i = 0; i < this.localHeadGeometry.length; i ++ ) {
            const vertex = this.localHeadGeometry[ i ].clone();
            vertex.applyQuaternion( tempQuaternion );
            vertex.add( tempOffset );

            const positionIndex = ( ( this.VerticesPerNode * nodeIndex ) + i ) * TrailRenderer.PositionComponentCount;
            positions.array[ positionIndex ] = vertex.x;
            positions.array[ positionIndex + 1 ] = vertex.y;
            positions.array[ positionIndex + 2 ] = vertex.z;
        }

        positions.needsUpdate = true;
    }

    updateNodePositionsFromTransformMatrix( nodeIndex, transformMatrix ) {
        const positions = this.geometry.getAttribute( 'position' );

        const tempPosition = new Vector3( 0, 0, 0 );
        tempPosition.applyMatrix4( transformMatrix );
        this.updateNodeCenter( nodeIndex, tempPosition );

        const tempLocalHeadGeometry = [];
        for ( let i = 0; i < this.localHeadGeometry.length; i ++ ) {
            tempLocalHeadGeometry.push( this.localHeadGeometry[ i ].clone() );
        }
        for ( let i = 0; i < tempLocalHeadGeometry.length; i ++ ) {
            tempLocalHeadGeometry[ i ].applyMatrix4( transformMatrix );
        }

        if ( this.lastNodeCenter && this.orientToMovement ) {
            const tempMatrix3 = new Matrix3();
            getMatrix3FromMatrix4( tempMatrix3, transformMatrix );
            const worldOrientation = new Vector3( 0, 0, - 1 );
            worldOrientation.applyMatrix3( tempMatrix3 );

            const tempDirection = this.currentNodeCenter.clone().sub( this.lastNodeCenter ).normalize();

            if ( tempDirection.lengthSq() <= 0.0001 && this.lastOrientationDir ) {
                tempDirection.copy( this.lastOrientationDir );
            }

            if ( tempDirection.lengthSq() > 0.0001 ) {
                if ( ! this.lastOrientationDir ) this.lastOrientationDir = new Vector3();
                const tempQuaternion = new Quaternion().setFromUnitVectors( worldOrientation, tempDirection );
                const tempOffset = this.currentNodeCenter.clone();

                for ( let i = 0; i < tempLocalHeadGeometry.length; i ++ ) {
                    const vertex = tempLocalHeadGeometry[ i ];
                    vertex.sub( tempOffset );
                    vertex.applyQuaternion( tempQuaternion );
                    vertex.add( tempOffset );
                }
            }
        }

        for ( let i = 0; i < tempLocalHeadGeometry.length; i ++ ) {
            const positionIndex = ( ( this.VerticesPerNode * nodeIndex ) + i ) * TrailRenderer.PositionComponentCount;
            const transformedHeadVertex = tempLocalHeadGeometry[ i ];
            positions.array[ positionIndex ] = transformedHeadVertex.x;
            positions.array[ positionIndex + 1 ] = transformedHeadVertex.y;
            positions.array[ positionIndex + 2 ] = transformedHeadVertex.z;
        }

        positions.needsUpdate = true;
    }

    connectNodes( srcNodeIndex, destNodeIndex ) {
        const indices = this.geometry.getIndex();
        for ( let i = 0; i < this.localHeadGeometry.length - 1; i ++ ) {
            const srcVertexIndex = ( this.VerticesPerNode * srcNodeIndex ) + i;
            const destVertexIndex = ( this.VerticesPerNode * destNodeIndex ) + i;
            const faceIndex = ( ( srcNodeIndex * this.FacesPerNode ) + ( i * TrailRenderer.FacesPerQuad ) ) * TrailRenderer.IndicesPerFace;

            indices.array[ faceIndex ] = srcVertexIndex;
            indices.array[ faceIndex + 1 ] = destVertexIndex;
            indices.array[ faceIndex + 2 ] = srcVertexIndex + 1;
            indices.array[ faceIndex + 3 ] = destVertexIndex;
            indices.array[ faceIndex + 4 ] = destVertexIndex + 1;
            indices.array[ faceIndex + 5 ] = srcVertexIndex + 1;
        }
        indices.needsUpdate = true;
    }

    disconnectNodes( srcNodeIndex ) {
        const indices = this.geometry.getIndex();
        for ( let i = 0; i < this.localHeadGeometry.length - 1; i ++ ) {
            const faceIndex = ( ( srcNodeIndex * this.FacesPerNode ) + ( i * TrailRenderer.FacesPerQuad ) ) * TrailRenderer.IndicesPerFace;
            indices.array[ faceIndex ] = 0;
            indices.array[ faceIndex + 1 ] = 0;
            indices.array[ faceIndex + 2 ] = 0;
            indices.array[ faceIndex + 3 ] = 0;
            indices.array[ faceIndex + 4 ] = 0;
            indices.array[ faceIndex + 5 ] = 0;
        }
        indices.needsUpdate = true;
    }

    deactivate() {
        if ( this.isActive ) {
            this.scene.remove( this.mesh );
            this.isActive = false;
        }
    }

    activate() {
        if ( ! this.isActive ) {
            this.scene.add( this.mesh );
            this.isActive = true;
        }
    }

    static createMaterial( vertexShader, fragmentShader, customUniforms ) {
        customUniforms = customUniforms || {};

        customUniforms.trailLength = { type: 'f', value: null };
        customUniforms.verticesPerNode = { type: 'f', value: null };
        customUniforms.minID = { type: 'f', value: null };
        customUniforms.maxID = { type: 'f', value: null };
        customUniforms.dragTexture = { type: 'f', value: null };
        customUniforms.maxTrailLength = { type: 'f', value: null };
        customUniforms.textureTileFactor = { type: 'v2', value: null };
        customUniforms.headColor = { type: 'v4', value: new Vector4() };
        customUniforms.tailColor = { type: 'v4', value: new Vector4() };

        vertexShader = vertexShader || TrailRenderer.Shader.BaseVertexShader;
        fragmentShader = fragmentShader || TrailRenderer.Shader.BaseFragmentShader;

        return new ShaderMaterial( {
            uniforms: customUniforms,
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            transparent: true,
            alphaTest: 0.5,
            blending: CustomBlending,
            blendSrc: SrcAlphaFactor,
            blendDst: OneMinusSrcAlphaFactor,
            blendEquation: AddEquation,
            depthTest: true,
            depthWrite: false,
            side: DoubleSide
        } );
    }

    static createBaseMaterial( customUniforms ) {
        return this.createMaterial( TrailRenderer.Shader.BaseVertexShader, TrailRenderer.Shader.BaseFragmentShader, customUniforms );
    }

    static createTexturedMaterial( customUniforms ) {
        customUniforms = {};
        customUniforms.texture = { type: 't', value: null };
        return this.createMaterial( TrailRenderer.Shader.TexturedVertexShader, TrailRenderer.Shader.TexturedFragmentShader, customUniforms );
    }
}

function getMatrix3FromMatrix4( matrix3, matrix4 ) {
    const e = matrix4.elements;
    matrix3.set( e[ 0 ], e[ 1 ], e[ 2 ],
        e[ 4 ], e[ 5 ], e[ 6 ],
        e[ 8 ], e[ 9 ], e[ 10 ] );
}

TrailRenderer.MaxHeadVertices = 128;
TrailRenderer.LocalOrientationTangent = new Vector3( 1, 0, 0 );
TrailRenderer.LocalOrientationDirection = new Vector3( 0, 0, - 1 );
TrailRenderer.LocalHeadOrigin = new Vector3( 0, 0, 0 );
TrailRenderer.PositionComponentCount = 3;
TrailRenderer.UVComponentCount = 2;
TrailRenderer.IndicesPerFace = 3;
TrailRenderer.FacesPerQuad = 2;

TrailRenderer.Shader = {};

TrailRenderer.Shader.BaseVertexVars = [
    'attribute float nodeID;',
    'attribute float nodeVertexID;',
    'attribute vec3 nodeCenter;',
    'uniform float minID;',
    'uniform float maxID;',
    'uniform float trailLength;',
    'uniform float maxTrailLength;',
    'uniform float verticesPerNode;',
    'uniform vec2 textureTileFactor;',
    'uniform vec4 headColor;',
    'uniform vec4 tailColor;',
    'varying vec4 vColor;',
].join( '\n' );

TrailRenderer.Shader.TexturedVertexVars = [
    TrailRenderer.Shader.BaseVertexVars,
    'varying vec2 vUV;',
    'uniform float dragTexture;',
].join( '\n' );

TrailRenderer.Shader.BaseFragmentVars = [
    'varying vec4 vColor;',
    'uniform sampler2D texture;',
].join( '\n' );

TrailRenderer.Shader.TexturedFragmentVars = [
    TrailRenderer.Shader.BaseFragmentVars,
    'varying vec2 vUV;',
].join( '\n' );

TrailRenderer.Shader.VertexShaderCore = [
    'float fraction = ( maxID - nodeID ) / ( maxID - minID );',
    'vColor = ( 1.0 - fraction ) * headColor + fraction * tailColor;',
    'vec4 realPosition = vec4( ( 1.0 - fraction ) * position.xyz + fraction * nodeCenter.xyz, 1.0 ); ',
].join( '\n' );

TrailRenderer.Shader.BaseVertexShader = [
    TrailRenderer.Shader.BaseVertexVars,
    'void main() { ',
    TrailRenderer.Shader.VertexShaderCore,
    'gl_Position = projectionMatrix * viewMatrix * realPosition;',
    '}',
].join( '\n' );

TrailRenderer.Shader.BaseFragmentShader = [
    TrailRenderer.Shader.BaseFragmentVars,
    'void main() { ',
    'gl_FragColor = vColor;',
    '}',
].join( '\n' );

TrailRenderer.Shader.TexturedVertexShader = [
    TrailRenderer.Shader.TexturedVertexVars,
    'void main() { ',
    TrailRenderer.Shader.VertexShaderCore,
    'float s = 0.0;',
    'float t = 0.0;',
    'if ( dragTexture == 1.0 ) { ',
    '   s = fraction * textureTileFactor.s; ',
    '   t = ( nodeVertexID / verticesPerNode ) * textureTileFactor.t;',
    '} else { ',
    '   s = nodeID / maxTrailLength * textureTileFactor.s;',
    '   t = ( nodeVertexID / verticesPerNode ) * textureTileFactor.t;',
    '}',
    'vUV = vec2( s, t ); ',
    'gl_Position = projectionMatrix * viewMatrix * realPosition;',
    '}',
].join( '\n' );

TrailRenderer.Shader.TexturedFragmentShader = [
    TrailRenderer.Shader.TexturedFragmentVars,
    'void main() { ',
    'vec4 textureColor = texture2D( texture, vUV );',
    'gl_FragColor = vColor * textureColor;',
    '}',
].join( '\n' );
