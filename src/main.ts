import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { VRMLoaderPlugin } from "@pixiv/three-vrm";
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from "@pixiv/three-vrm-animation";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { FilesetResolver, PoseLandmarker } from "@mediapipe/tasks-vision";
import { VRM } from "@pixiv/three-vrm";
import { GUI } from 'lil-gui';

type PosePoint = {
  x: number;
  y: number;
  z: number;
  visibility?: number;
};

class ThreeJSContainer {
  private scene!: THREE.Scene;
  private light!: THREE.Light;
  private vrm: VRM | null = null;
  private mixer?: THREE.AnimationMixer;
  private actions: { [key: string]: THREE.AnimationAction } = {};
  private currentAction?: THREE.AnimationAction;
  private renderer!: THREE.WebGLRenderer;
  private background!: THREE.Mesh;
  private lastTime = 0;
  private poseLandmarker?: PoseLandmarker;
  private webcamVideo!: HTMLVideoElement;
  private webcamStream?: MediaStream;
  private poseLoopActive = false;
  private lastVideoTime = -1;
  private lastPoseLogTime = 0;
  private armRestPose = new Map<string, THREE.Quaternion>();

  public createRendererDOM = (width: number, height: number, cameraPos: THREE.Vector3) => {
    this.renderer = new THREE.WebGLRenderer();
    this.renderer.setSize(width, height);
    this.renderer.setClearColor(0x495ed);

    let camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.copy(cameraPos);
    camera.lookAt(new THREE.Vector3(0, 0, 0));

    let orbitControls = new OrbitControls(camera, this.renderer.domElement);
    orbitControls.target.set(0, 1, 0);

    this.createScene();

    let render: FrameRequestCallback = (_time) => {
      orbitControls.update();

      let deltaTime = 0;
      if (this.lastTime !== 0) {
        deltaTime = (_time - this.lastTime) / 1000;
      }

      this.lastTime = _time;

      if (this.mixer) {
        this.mixer.update(deltaTime);
      }

      if (this.vrm) {
        this.vrm.update(deltaTime);
      }

      this.renderer.render(this.scene, camera);
      requestAnimationFrame(render);
    }
    requestAnimationFrame(render);

    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.margin = "10px auto";
    return this.renderer.domElement;
  }

  private createScene = () => {
    this.scene = new THREE.Scene();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

    loader.load("/models/avatar.vrm", async (gltf) => {
      this.vrm = gltf.userData.vrm;

      if (!this.vrm) {
        console.error("VRMの読み込みに失敗しました");
        return;
      }

      this.scene.add(this.vrm.scene);
      this.saveArmRestPose();

      this.mixer = new THREE.AnimationMixer(this.vrm.scene);
      await this.loadAnimation(loader, "/animation/VRMA_MotionPack/vrma/VRMA_02.vrma", "greeting");
      await this.loadAnimation(loader, "/animation/VRMA_MotionPack/vrma/VRMA_01.vrma", "show body");

    });

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshStandardMaterial({
        color: 0x808080,
        // side: THREE.DoubleSide
      })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    this.scene.add(floor);

    this.background = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 2.25),
    );
    this.background.position.y = 1.1;
    this.background.position.z = 1;
    this.background.rotation.y = Math.PI;
    this.scene.add(this.background);

    const gui = new GUI();
    const guiFace = { face: 'normal' };
    const guiAnimation = { animation: 'Tpose' };
    const guiBackgroundColor = { backgroundColor: 'normal' };
    const guiBackground = { background: 'none' };
    gui.add(guiFace, "face", ["normal", "happy", "angry"])
      .onChange((value: string) => {

        if (!this.vrm) return;

        this.vrm.expressionManager?.setValue("happy", 0);
        this.vrm.expressionManager?.setValue("angry", 0);

        switch (value) {
          case "happy":
            this.vrm.expressionManager?.setValue("happy", 1);
            break;

          case "angry":
            this.vrm.expressionManager?.setValue("angry", 1);
            break;
        }
      });
    gui.add(guiAnimation, "animation", ["Tpose", "greeting", "show body"])
      .onChange((value: string) => {
        this.playAnimation(value);
      });
    gui.add(guiBackgroundColor, "backgroundColor", ["normal", "sunset", "night"])
      .onChange((value: string) => {
        this.changeBackgroundColor(value);
      });
    gui.add(guiBackground, "background", ["none", "SP6C-WallPaper-16-9"])
      .onChange((value: string) => {
        this.changeBackground(value);
      });

    const motionCapture = {
      start: () => void this.startMotionCapture(),
      stop: () => this.stopMotionCapture(),
    };

    const motionCaptureFolder = gui.addFolder("Motion Capture");
    motionCaptureFolder.add(motionCapture, "start").name("Start camera");
    motionCaptureFolder.add(motionCapture, "stop").name("Stop camera");

    this.light = new THREE.DirectionalLight(0xffffff);
    let lvec = new THREE.Vector3(1, 1, 1).normalize();
    this.light.position.set(lvec.x, lvec.y, lvec.z);
    this.scene.add(this.light);

    let update: FrameRequestCallback = (_time) => {
      requestAnimationFrame(update);
    }
    requestAnimationFrame(update);
  }

  private loadAnimation = async (
    loader: GLTFLoader,
    path: string,
    name: string
  ) => {

    if (!this.vrm || !this.mixer) return;

    const gltf = await loader.loadAsync(path);

    const vrmAnimation = gltf.userData.vrmAnimations?.[0];

    if (!vrmAnimation) {
      console.error(`${name} のVRMAが見つかりません`);
      return;
    }

    const clip = createVRMAnimationClip(
      vrmAnimation,
      this.vrm
    );

    const action = this.mixer.clipAction(clip);

    this.actions[name] = action;
  };

  private playAnimation = (name: string) => {

    if (this.currentAction) {
      this.currentAction.stop();
      this.currentAction = undefined;
    }

    if (name === "Tpose") {
      return;
    }

    const nextAction = this.actions[name];

    if (!nextAction) {
      console.error(`アニメーション ${name} がありません`);
      return;
    }

    nextAction.reset();
    nextAction.play();

    this.currentAction = nextAction;
  };

  private changeBackgroundColor = (type: string) => {

    switch (type) {

      case "normal":
        this.renderer.setClearColor(0x495ed);
        break;

      case "sunset":
        this.renderer.setClearColor(0xff9966);
        this.light.intensity = 1.5;
        break;

      case "night":
        this.renderer.setClearColor(0x111122);
        this.light.intensity = 0.5;
        break;
    }
  };

  private changeBackground = (name: string) => {
    if (name === "none") {
      const material =
        this.background.material as THREE.MeshBasicMaterial;

      material.map = null;
      material.needsUpdate = true;
      return;
    }

    const textureLoader = new THREE.TextureLoader();

    const texture = textureLoader.load(
      `/backgrounds/${name}.png`
    );

    const material =
      this.background.material as THREE.MeshBasicMaterial;

    material.map = texture;
    material.needsUpdate = true;
  };

  private initializePoseLandmarker = async () => {
    if (this.poseLandmarker) return;

    const vision = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm",
    );

    this.poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: {
        modelAssetPath:
          "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
      },
      runningMode: "VIDEO",
      numPoses: 1,
    });
  };

  private startMotionCapture = async () => {
    const video = document.getElementById("webcam") as HTMLVideoElement | null;
    const status = document.getElementById("pose-status");

    if (!video) {
      console.error("#webcam が見つかりません");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia) {
      console.error("このページはカメラAPIを利用できません。localhost または HTTPS で開いてください。");
      if (status) status.textContent = "localhost または HTTPS で開いてください。";
      return;
    }

    try {
      if (status) status.textContent = "カメラへのアクセスを確認中...";

      // 先にここでブラウザの許可ダイアログを出す
      this.webcamStream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: false,
      });

      this.webcamVideo = video;
      this.webcamVideo.srcObject = this.webcamStream;
      await this.webcamVideo.play();

      if (status) status.textContent = "MediaPipeを準備中...";
      await this.initializePoseLandmarker();

      this.currentAction?.stop();
      this.currentAction = undefined;
      this.mixer?.stopAllAction();
      this.poseLoopActive = true;
      this.lastVideoTime = -1;
      this.detectPose();

      if (status) status.textContent = "認識中：カメラに全身を映してください";
    } catch (error) {
      console.error("カメラまたはPose Landmarkerの開始に失敗しました", error);

      if (status) {
        status.textContent = "開始に失敗しました。コンソールを確認してください。";
      }
    }
  };

  private detectPose = () => {
    if (!this.poseLoopActive || !this.poseLandmarker) return;

    if (
      this.webcamVideo.readyState >= 2 &&
      this.webcamVideo.currentTime !== this.lastVideoTime
    ) {
      const result = this.poseLandmarker.detectForVideo(
        this.webcamVideo,
        performance.now(),
      );

      this.lastVideoTime = this.webcamVideo.currentTime;

      const landmarks = result.landmarks[0];
      const worldLandmarks = result.worldLandmarks[0];

      if (worldLandmarks) {
        this.updateSpineFromPose(worldLandmarks);
        this.updateNeckFromPose(worldLandmarks);
        this.updateArmsFromPose(worldLandmarks);
      }

      if (landmarks) {
        const now = performance.now();

        // 毎フレームconsole.logすると重くなるため、1秒ごとに確認する
        if (now - this.lastPoseLogTime > 1000) {
          console.log("Pose landmarks（33点）:", landmarks);
          console.log("Pose world landmarks:", result.worldLandmarks[0]);
          this.lastPoseLogTime = now;
        }

        const status = document.getElementById("pose-status");
        if (status) status.textContent = "認識中：33点のランドマークを取得しました";
      }
    }

    requestAnimationFrame(this.detectPose);
  };

  private stopMotionCapture = () => {
    this.poseLoopActive = false;

    this.webcamStream?.getTracks().forEach((track) => track.stop());
    this.webcamStream = undefined;

    if (this.webcamVideo) {
      this.webcamVideo.srcObject = null;
    }

    const status = document.getElementById("pose-status");
    if (status) status.textContent = "カメラは停止中です";
  };

  private saveArmRestPose = () => {
    if (!this.vrm) return;

    const humanoid = this.vrm.humanoid;

    for (const boneName of [
      "spine",
      "neck",
      "leftUpperArm",
      "leftLowerArm",
      "rightUpperArm",
      "rightLowerArm",
    ] as const) {
      const bone = humanoid?.getNormalizedBoneNode(boneName);

      if (bone) {
        this.armRestPose.set(boneName, bone.quaternion.clone());
      }
    }
    this.resetArmPose();
  };

  private updateArmsFromPose = (landmarks: PosePoint[]) => {
    if (!this.vrm || landmarks.length < 17) return;

    // MediaPipe Pose の番号
    // 11: 左肩 / 12: 右肩
    // 13: 左肘 / 14: 右肘
    // 15: 左手首 / 16: 右手首
    this.rotateArmBone("leftUpperArm", "leftLowerArm", landmarks[11], landmarks[13]);
    this.rotateArmBone("leftLowerArm", "leftHand", landmarks[13], landmarks[15]);

    this.rotateArmBone("rightUpperArm", "rightLowerArm", landmarks[12], landmarks[14]);
    this.rotateArmBone("rightLowerArm", "rightHand", landmarks[14], landmarks[16]);
  };

  private rotateArmBone = (
    boneName: "leftUpperArm" | "leftLowerArm" | "rightUpperArm" | "rightLowerArm",
    childBoneName: "leftLowerArm" | "leftHand" | "rightLowerArm" | "rightHand",
    from: PosePoint,
    to: PosePoint,
  ) => {
    if (!this.vrm) return;

    // 画面外などで認識が不安定なときは更新しない
    if ((from.visibility ?? 1) < 0.5 || (to.visibility ?? 1) < 0.5) return;

    const humanoid = this.vrm.humanoid;
    const bone = humanoid?.getNormalizedBoneNode(boneName);
    const childBone = humanoid?.getNormalizedBoneNode(childBoneName);
    const restQuaternion = this.armRestPose.get(boneName);

    if (!bone || !childBone || !bone.parent || !restQuaternion) return;

    // MediaPipeの座標系をThree.js/VRM用の向きへ変換する
    const depthScale = -0.4;

    const targetDirection = new THREE.Vector3(
      -(to.x - from.x),
      -(to.y - from.y),
      -(to.z - from.z) * depthScale,
    ).normalize();

    // 親ボーン基準の方向へ変換
    const parentWorldQuaternion = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorldQuaternion);

    const targetInParent = targetDirection
      .clone()
      .applyQuaternion(parentWorldQuaternion.invert())
      .normalize();

    // 初期姿勢で「子ボーンが向いている方向」
    const sourceInParent = childBone.position
      .clone()
      .normalize()
      .applyQuaternion(restQuaternion);

    const correction = new THREE.Quaternion().setFromUnitVectors(
      sourceInParent,
      targetInParent,
    );

    const targetQuaternion = correction.multiply(restQuaternion);

    // 追従を少し滑らかにする
    bone.quaternion.slerp(targetQuaternion, 0.35);
  };

  private resetArmPose = () => {
    if (!this.vrm) return;

    for (const [boneName, quaternion] of this.armRestPose) {
      const bone = this.vrm.humanoid?.getNormalizedBoneNode(
        boneName as
        | "spine"
        | "neck"
        | "leftUpperArm"
        | "leftLowerArm"
        | "rightUpperArm"
        | "rightLowerArm",
      );

      bone?.quaternion.copy(quaternion);
    }
  };
  private updateSpineFromPose = (landmarks: PosePoint[]) => {
    if (!this.vrm || landmarks.length < 25) return;

    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];
    const leftHip = landmarks[23];
    const rightHip = landmarks[24];

    const shoulderCenter: PosePoint = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2,
      z: (leftShoulder.z + rightShoulder.z) / 2,
    };

    const hipCenter: PosePoint = {
      x: (leftHip.x + rightHip.x) / 2,
      y: (leftHip.y + rightHip.y) / 2,
      z: (leftHip.z + rightHip.z) / 2,
    };

    const spine = this.vrm.humanoid?.getNormalizedBoneNode("spine");
    const chest = this.vrm.humanoid?.getNormalizedBoneNode("chest");
    const restQuaternion = this.armRestPose.get("spine");

    if (!spine || !chest || !spine.parent || !restQuaternion) return;

    const depthScale = 0.1;

    const targetDirection = new THREE.Vector3(
      -(shoulderCenter.x - hipCenter.x),
      -(shoulderCenter.y - hipCenter.y),
      -(shoulderCenter.z - hipCenter.z) * depthScale,
    ).normalize();

    const parentWorldQuaternion = new THREE.Quaternion();
    spine.parent.getWorldQuaternion(parentWorldQuaternion);

    const targetInParent = targetDirection
      .clone()
      .applyQuaternion(parentWorldQuaternion.invert())
      .normalize();

    const sourceInParent = chest.position
      .clone()
      .normalize()
      .applyQuaternion(restQuaternion);

    const correction = new THREE.Quaternion().setFromUnitVectors(
      sourceInParent,
      targetInParent,
    );

    const targetQuaternion = correction.multiply(restQuaternion);

    // 腕よりゆっくり追従させる
    spine.quaternion.slerp(targetQuaternion, 0.25);
  };
  private updateNeckFromPose = (landmarks: PosePoint[]) => {
    if (!this.vrm || landmarks.length < 13) return;

    const nose = landmarks[0];
    const leftShoulder = landmarks[11];
    const rightShoulder = landmarks[12];

    const shoulderCenter: PosePoint = {
      x: (leftShoulder.x + rightShoulder.x) / 2,
      y: (leftShoulder.y + rightShoulder.y) / 2,
      z: (leftShoulder.z + rightShoulder.z) / 2,
    };

    const neck = this.vrm.humanoid?.getNormalizedBoneNode("neck");
    const head = this.vrm.humanoid?.getNormalizedBoneNode("head");
    const restQuaternion = this.armRestPose.get("neck");

    if (!neck || !head || !neck.parent || !restQuaternion) return;

    const targetDirection = new THREE.Vector3(
      -(nose.x - shoulderCenter.x) * 0.4,
      -(nose.y - shoulderCenter.y),
      (nose.z - shoulderCenter.z) * 0.15,
    ).normalize();

    const parentWorldQuaternion = new THREE.Quaternion();
    neck.parent.getWorldQuaternion(parentWorldQuaternion);

    const targetInParent = targetDirection
      .clone()
      .applyQuaternion(parentWorldQuaternion.invert())
      .normalize();

    const sourceInParent = head.position
      .clone()
      .normalize()
      .applyQuaternion(restQuaternion);

    const correction = new THREE.Quaternion().setFromUnitVectors(
      sourceInParent,
      targetInParent,
    );

    const targetQuaternion = correction.multiply(restQuaternion);

    // 首はゆっくり、控えめに追従
    neck.quaternion.slerp(targetQuaternion, 0.08);
  };
}

window.addEventListener("DOMContentLoaded", init);

function init() {
  let container = new ThreeJSContainer();

  let viewport = container.createRendererDOM(1024, 768, new THREE.Vector3(0, 1, -1.5));
  document.body.appendChild(viewport);
}