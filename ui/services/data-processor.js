// Data Processor - WiFi DensePose 3D Visualization
// Transforms API data into Three.js geometry updates

export class DataProcessor {
  constructor() {
    // Demo mode state
    this.demoMode = false;
    this.demoElapsed = 0;
    this.demoPoseIndex = 0;
    this.demoPoseCycleTime = 4; // seconds per pose transition

    // Pre-recorded demo poses (COCO 17-keypoint format, normalized [0,1])
    // Each pose: array of {x, y, confidence} for 17 keypoints
    this.demoPoses = this._buildDemoPoses();
    this.sleepingPose = this._buildSleepingPose();

    // Smoothing buffers
    this._lastProcessedPersons = [];
    this._smoothingFactor = 0.3;
    this._smoothedPositions = {};
  }

  // Process incoming WebSocket message into visualization-ready data
  processMessage(message) {
    if (!message) return null;

    const result = {
      persons: [],
      zoneOccupancy: {},
      signalData: null,
      metadata: {
        isRealData: false,
        timestamp: null,
        processingTime: 0,
        frameId: null,
        sensingMode: 'Mock'
      }
    };

    // Handle different message types from the API
    if (message.type === 'sensing_update') {
      const classification = message.classification || {};
      const features = message.features || {};
      const nodes = Array.isArray(message.nodes) ? message.nodes : [];
      const present = !!classification.presence;
      const motionLevel = classification.motion_level || 'absent';

      result.metadata.isRealData = message._simulated !== true;
      result.metadata.timestamp = message.timestamp;
      result.metadata.processingTime = 0;
      result.metadata.frameId = message.frame_id || `sensing_${Date.now()}`;
      result.metadata.sensingMode = features.mean_rssi != null ? 'RSSI' : 'Mock';

      if (present) {
        const basePose = motionLevel === 'active'
          ? (this.demoPoses[1] || this.demoPoses[0])
          : (this.demoPoses[0] || this.demoPoses[1]);
        const node = nodes[0] || {};
        const rssi = typeof node.rssi_dbm === 'number'
          ? node.rssi_dbm
          : (typeof features.mean_rssi === 'number' ? features.mean_rssi : -55);
        const offset = Math.max(-0.12, Math.min(0.12, (rssi + 55) / 100));

        result.persons = [{
          id: node.node_id != null ? `node_${node.node_id}` : 'person_0',
          confidence: classification.confidence != null ? classification.confidence : 0.85,
          keypoints: basePose.map((kp, index) => ({
            x: Math.max(0, Math.min(1, kp.x + offset + Math.sin(Date.now() / 1000 + index) * 0.004)),
            y: kp.y,
            confidence: kp.confidence
          })),
          bbox: null,
          body_parts: this._generateDemoBodyParts(Date.now() / 1000),
          y: 0,
          z: 0,
          rotationY: 0
        }];

        result.zoneOccupancy = { zone_2: 1 };
        result.signalData = {
          amplitude: Array.isArray(message.signal_field?.values)
            ? message.signal_field.values.slice(0, 30)
            : this._buildFallbackAmplitude(features.mean_rssi),
          phase: this._buildFallbackPhase(),
          doppler: this._buildFallbackDoppler(features.motion_band_power || 0),
          motionEnergy: features.motion_band_power || 0
        };
      }
    } else if (message.type === 'pose_data') {
      const payload = message.data || message.payload;
      if (payload) {
        result.persons = this._extractPersons(payload);
        result.zoneOccupancy = this._extractZoneOccupancy(payload, message.zone_id);
        result.signalData = this._extractSignalData(payload);

        result.metadata.isRealData = payload.metadata?.mock_data === false;
        result.metadata.timestamp = message.timestamp;
        result.metadata.processingTime = payload.metadata?.processing_time_ms || 0;
        result.metadata.frameId = payload.metadata?.frame_id;

        // Determine sensing mode
        if (payload.metadata?.source === 'csi') {
          result.metadata.sensingMode = 'CSI';
        } else if (payload.metadata?.source === 'rssi') {
          result.metadata.sensingMode = 'RSSI';
        } else if (payload.metadata?.mock_data !== false) {
          result.metadata.sensingMode = 'Mock';
        } else {
          result.metadata.sensingMode = 'CSI';
        }
      }
    } else if (message.msg_type === 'edge_vitals') {
      result.metadata.isRealData = true;
      result.metadata.timestamp = message.timestamp_ms;
      result.metadata.sensingMode = 'CSI';
      result.metadata.frameId = `ev_${message.timestamp_ms}`;

      const numPersons = message.n_persons !== undefined ? message.n_persons : (message.presence ? 1 : 0);

      if (numPersons > 0) {
        if (!this.realElapsed) this.realElapsed = 0;
        this.realElapsed += 0.05; // increment animation timer

        // RSSI-based distance calculation
        const baseRssi = message.rssi || -55;
        const minRssi = -35;
        const maxRssi = -85;
        let percent = (baseRssi - minRssi) / (maxRssi - minRssi);
        percent = Math.max(0.15, Math.min(0.85, percent));
        const radius = percent * 4.0; // scale up to 4.0 meters

        const baseAngles = [
          3 * Math.PI / 2, // Zone 2 (Center)
          Math.PI,         // Zone 1 (Left)
          0,               // Zone 3 (Right)
          5 * Math.PI / 4, // Left-Center
          7 * Math.PI / 4  // Right-Center
        ];

        const PRESENTIAL_SLOTS = [
          { x: 2.1, y: 0.55, z: 1.5, pose: 'sitting', rotationY: 0 },          // Bed (User sitting)
          { x: 1.7, y: 0.45, z: -1.4, pose: 'sleeping', rotationY: Math.PI / 2 }, // Sofa (Human 2 sleeping)
          { x: -0.5, y: 0.05, z: 0.1, pose: 'sleeping', rotationY: Math.PI / 4 }   // Floor (Dog sleeping)
        ];

        const updatedIds = new Set();
        for (let i = 0; i < numPersons; i++) {
          const personId = `esp32_person_${i}`;
          updatedIds.add(personId);

          const slot = PRESENTIAL_SLOTS[i % PRESENTIAL_SLOTS.length];
          let xTarget = slot.x;
          let yTarget = slot.y;
          let zTarget = slot.z;
          let rotY = slot.rotationY;

          if (message.motion) {
            // Active: allow dynamic movement centered around the slot
            const wanderSpeed = 0.3 + (i * 0.1);
            const wanderRange = 0.4;
            xTarget += Math.sin(this.realElapsed * wanderSpeed) * wanderRange;
            zTarget += Math.cos(this.realElapsed * wanderSpeed) * wanderRange;
            yTarget = 0.0; // stand/walk on the ground when active
            rotY = Math.sin(this.realElapsed * wanderSpeed) * Math.PI;
          } else {
            // Still: apply subtle breathing micro-movement
            const breathFreq = 1.2 + i * 0.2;
            const breathAmp = 0.015;
            xTarget += Math.sin(this.realElapsed * breathFreq) * breathAmp;
            zTarget += Math.cos(this.realElapsed * breathFreq) * breathAmp;
          }

          // Apply EMA smoothing to coordinate changes to filter raw RSSI noise
          if (this._smoothedPositions[personId]) {
            const alpha = message.motion ? 0.15 : 0.015;
            xTarget = this._smoothedPositions[personId].x + alpha * (xTarget - this._smoothedPositions[personId].x);
            zTarget = this._smoothedPositions[personId].z + alpha * (zTarget - this._smoothedPositions[personId].z);
            const prevY = this._smoothedPositions[personId].y !== undefined ? this._smoothedPositions[personId].y : yTarget;
            yTarget = prevY + alpha * (yTarget - prevY);
          }
          this._smoothedPositions[personId] = { x: xTarget, y: yTarget, z: zTarget };

          // Set keypoint offset to achieve xTarget
          // Since mapX maps [0,1] to [-2,2] meters: (x - 0.5) * 4
          // We want the average hip X to map to xTarget, so offset is xTarget / 4
          const offset = xTarget / 4;

          let keypoints = [];
          if (message.motion) {
            // Cycle through walking poses (phase-shifted per person)
            const walkPoses = [this.demoPoses[1], this.demoPoses[3]];
            const t = ((this.realElapsed + i * 0.4) % 2.0) / 2.0; // phase-shifted
            const idx = Math.floor(t * walkPoses.length);
            const nextIdx = (idx + 1) % walkPoses.length;
            const progress = (t * walkPoses.length) % 1.0;
            
            keypoints = walkPoses[idx].map((kp, k) => {
              const next = walkPoses[nextIdx][k];
              return {
                x: kp.x + (next.x - kp.x) * progress + offset,
                y: kp.y + (next.y - kp.y) * progress,
                confidence: 0.95
              };
            });
          } else {
            // Still: use slot-specific pose (sitting or sleeping)
            const basePose = slot.pose === 'sitting' ? this.demoPoses[6] : this.sleepingPose;
            keypoints = basePose.map(kp => ({
              x: kp.x + offset,
              y: kp.y,
              confidence: 0.95
            }));
          }

          result.persons.push({
            id: personId,
            confidence: message.presence_score || 0.95,
            keypoints: keypoints,
            bbox: null,
            body_parts: this._generateDemoBodyParts(this.realElapsed + i * 0.5),
            y: yTarget,
            z: zTarget,
            rotationY: rotY
          });
        }

        // Clean up stale IDs
        for (const id in this._smoothedPositions) {
          if (!updatedIds.has(id)) {
            delete this._smoothedPositions[id];
          }
        }

        // Calculate dynamic zone occupancy based on X positions
        result.zoneOccupancy = {};
        for (const person of result.persons) {
          const hipX = (person.keypoints[11].x + person.keypoints[12].x) / 2;
          let zone = 'zone_2';
          if (hipX < 0.35) zone = 'zone_1';
          else if (hipX > 0.65) zone = 'zone_3';
          result.zoneOccupancy[zone] = (result.zoneOccupancy[zone] || 0) + 1;
        }
      } else {
        result.persons = [];
        result.zoneOccupancy = {};
      }

      // Add synthetic signal/CSI data visualization based on the real RSSI
      const baseRssi = message.rssi || -45;
      const ampVal = Math.max(0, 1 + baseRssi / 100); // map -100..0 to 0..1
      result.signalData = {
        amplitude: [ampVal, ampVal * 0.8, ampVal * 0.9, ampVal * 0.7],
        phase: [0.1, 0.2, 0.3, 0.4],
        doppler: [0.05, 0.02, 0.08],
        motionEnergy: message.motion_energy
      };
    }

    return result;
  }

  // Extract person data with keypoints in COCO format
  _extractPersons(payload) {
    const persons = [];

    if (payload.pose && payload.pose.persons) {
      for (const person of payload.pose.persons) {
        const processed = {
          id: person.id || `person_${persons.length}`,
          confidence: person.confidence || 0,
          keypoints: this._normalizeKeypoints(person.keypoints),
          bbox: person.bbox || null,
          body_parts: person.densepose_parts || person.body_parts || null
        };
        persons.push(processed);
      }
    } else if (payload.persons) {
      // Alternative format: persons at top level
      for (const person of payload.persons) {
        persons.push({
          id: person.id || `person_${persons.length}`,
          confidence: person.confidence || 0,
          keypoints: this._normalizeKeypoints(person.keypoints),
          bbox: person.bbox || null,
          body_parts: person.densepose_parts || person.body_parts || null
        });
      }
    }

    return persons;
  }

  // Normalize keypoints to {x, y, confidence} format in [0,1] range
  _normalizeKeypoints(keypoints) {
    if (!keypoints || keypoints.length === 0) return [];

    return keypoints.map(kp => {
      // Handle various formats
      if (Array.isArray(kp)) {
        return { x: kp[0], y: kp[1], confidence: kp[2] || 0.5 };
      }
      return {
        x: kp.x !== undefined ? kp.x : 0,
        y: kp.y !== undefined ? kp.y : 0,
        confidence: kp.confidence !== undefined ? kp.confidence : (kp.score || 0.5)
      };
    });
  }

  // Extract zone occupancy data
  _extractZoneOccupancy(payload, zoneId) {
    const occupancy = {};

    if (payload.zone_summary) {
      Object.assign(occupancy, payload.zone_summary);
    }

    if (zoneId && payload.pose?.persons?.length > 0) {
      occupancy[zoneId] = payload.pose.persons.length;
    }

    return occupancy;
  }

  // Extract signal/CSI data if available
  _extractSignalData(payload) {
    if (payload.signal_data || payload.csi_data) {
      const sig = payload.signal_data || payload.csi_data;
      return {
        amplitude: sig.amplitude || null,
        phase: sig.phase || null,
        doppler: sig.doppler || sig.doppler_spectrum || null,
        motionEnergy: sig.motion_energy !== undefined ? sig.motion_energy : null
      };
    }
    return null;
  }

  // Generate demo data that cycles through pre-recorded poses
  generateDemoData(deltaTime) {
    this.demoElapsed += deltaTime;

    const totalPoses = this.demoPoses.length;
    const cycleProgress = (this.demoElapsed % (this.demoPoseCycleTime * totalPoses)) / this.demoPoseCycleTime;
    const currentPoseIdx = Math.floor(cycleProgress) % totalPoses;
    const nextPoseIdx = (currentPoseIdx + 1) % totalPoses;
    const t = cycleProgress - Math.floor(cycleProgress); // interpolation factor [0,1]

    // Smooth interpolation between poses
    const smoothT = t * t * (3 - 2 * t); // smoothstep

    const currentPose = this.demoPoses[currentPoseIdx];
    const nextPose = this.demoPoses[nextPoseIdx];

    const interpolatedKeypoints = currentPose.map((kp, i) => {
      const next = nextPose[i];
      return {
        x: kp.x + (next.x - kp.x) * smoothT,
        y: kp.y + (next.y - kp.y) * smoothT,
        confidence: 0.7 + Math.sin(this.demoElapsed * 2 + i * 0.5) * 0.2
      };
    });

    // Simulate confidence variation
    const baseConf = 0.65 + Math.sin(this.demoElapsed * 0.5) * 0.2;

    // Determine active zone based on position
    const hipX = (interpolatedKeypoints[11].x + interpolatedKeypoints[12].x) / 2;
    let activeZone = 'zone_2';
    if (hipX < 0.35) activeZone = 'zone_1';
    else if (hipX > 0.65) activeZone = 'zone_3';

    return {
      persons: [{
        id: 'demo_person_0',
        confidence: Math.max(0, Math.min(1, baseConf)),
        keypoints: interpolatedKeypoints,
        bbox: null,
        body_parts: this._generateDemoBodyParts(this.demoElapsed),
        z: Math.sin(this.demoElapsed * 0.3) * 1.5
      }],
      zoneOccupancy: {
        [activeZone]: 1
      },
      signalData: null, // SignalVisualization generates its own demo data
      metadata: {
        isRealData: false,
        timestamp: new Date().toISOString(),
        processingTime: 8 + Math.random() * 5,
        frameId: `demo_${Math.floor(this.demoElapsed * 30)}`,
        sensingMode: 'Mock'
      }
    };
  }

  _generateDemoBodyParts(elapsed) {
    const parts = {};
    for (let i = 1; i <= 24; i++) {
      // Simulate body parts being detected with varying confidence
      // Create a wave pattern across parts
      parts[i] = 0.4 + Math.sin(elapsed * 1.2 + i * 0.5) * 0.3 + Math.random() * 0.1;
      parts[i] = Math.max(0, Math.min(1, parts[i]));
    }
    return parts;
  }

  _buildDemoPoses() {
    // Pre-recorded poses: normalized COCO 17 keypoints
    // Each keypoint: {x, y, confidence}
    // Standing at center
    const standing = [
      { x: 0.50, y: 0.12, confidence: 0.9 },  // 0: nose
      { x: 0.48, y: 0.10, confidence: 0.8 },  // 1: left_eye
      { x: 0.52, y: 0.10, confidence: 0.8 },  // 2: right_eye
      { x: 0.46, y: 0.12, confidence: 0.7 },  // 3: left_ear
      { x: 0.54, y: 0.12, confidence: 0.7 },  // 4: right_ear
      { x: 0.42, y: 0.22, confidence: 0.9 },  // 5: left_shoulder
      { x: 0.58, y: 0.22, confidence: 0.9 },  // 6: right_shoulder
      { x: 0.38, y: 0.38, confidence: 0.85 }, // 7: left_elbow
      { x: 0.62, y: 0.38, confidence: 0.85 }, // 8: right_elbow
      { x: 0.36, y: 0.52, confidence: 0.8 },  // 9: left_wrist
      { x: 0.64, y: 0.52, confidence: 0.8 },  // 10: right_wrist
      { x: 0.45, y: 0.50, confidence: 0.9 },  // 11: left_hip
      { x: 0.55, y: 0.50, confidence: 0.9 },  // 12: right_hip
      { x: 0.44, y: 0.70, confidence: 0.85 }, // 13: left_knee
      { x: 0.56, y: 0.70, confidence: 0.85 }, // 14: right_knee
      { x: 0.44, y: 0.90, confidence: 0.8 },  // 15: left_ankle
      { x: 0.56, y: 0.90, confidence: 0.8 }   // 16: right_ankle
    ];

    // Walking - left leg forward
    const walkLeft = [
      { x: 0.50, y: 0.12, confidence: 0.9 },
      { x: 0.48, y: 0.10, confidence: 0.8 },
      { x: 0.52, y: 0.10, confidence: 0.8 },
      { x: 0.46, y: 0.12, confidence: 0.7 },
      { x: 0.54, y: 0.12, confidence: 0.7 },
      { x: 0.42, y: 0.22, confidence: 0.9 },
      { x: 0.58, y: 0.22, confidence: 0.9 },
      { x: 0.40, y: 0.35, confidence: 0.85 },
      { x: 0.60, y: 0.40, confidence: 0.85 },
      { x: 0.42, y: 0.48, confidence: 0.8 },
      { x: 0.56, y: 0.55, confidence: 0.8 },
      { x: 0.45, y: 0.50, confidence: 0.9 },
      { x: 0.55, y: 0.50, confidence: 0.9 },
      { x: 0.40, y: 0.68, confidence: 0.85 },
      { x: 0.58, y: 0.72, confidence: 0.85 },
      { x: 0.38, y: 0.88, confidence: 0.8 },
      { x: 0.56, y: 0.90, confidence: 0.8 }
    ];

    // Walking - right leg forward
    const walkRight = [
      { x: 0.50, y: 0.12, confidence: 0.9 },
      { x: 0.48, y: 0.10, confidence: 0.8 },
      { x: 0.52, y: 0.10, confidence: 0.8 },
      { x: 0.46, y: 0.12, confidence: 0.7 },
      { x: 0.54, y: 0.12, confidence: 0.7 },
      { x: 0.42, y: 0.22, confidence: 0.9 },
      { x: 0.58, y: 0.22, confidence: 0.9 },
      { x: 0.38, y: 0.40, confidence: 0.85 },
      { x: 0.62, y: 0.35, confidence: 0.85 },
      { x: 0.36, y: 0.55, confidence: 0.8 },
      { x: 0.60, y: 0.48, confidence: 0.8 },
      { x: 0.45, y: 0.50, confidence: 0.9 },
      { x: 0.55, y: 0.50, confidence: 0.9 },
      { x: 0.47, y: 0.72, confidence: 0.85 },
      { x: 0.52, y: 0.68, confidence: 0.85 },
      { x: 0.47, y: 0.90, confidence: 0.8 },
      { x: 0.50, y: 0.88, confidence: 0.8 }
    ];

    // Arms raised
    const armsUp = [
      { x: 0.50, y: 0.12, confidence: 0.9 },
      { x: 0.48, y: 0.10, confidence: 0.8 },
      { x: 0.52, y: 0.10, confidence: 0.8 },
      { x: 0.46, y: 0.12, confidence: 0.7 },
      { x: 0.54, y: 0.12, confidence: 0.7 },
      { x: 0.42, y: 0.22, confidence: 0.9 },
      { x: 0.58, y: 0.22, confidence: 0.9 },
      { x: 0.38, y: 0.15, confidence: 0.85 },
      { x: 0.62, y: 0.15, confidence: 0.85 },
      { x: 0.36, y: 0.05, confidence: 0.8 },
      { x: 0.64, y: 0.05, confidence: 0.8 },
      { x: 0.45, y: 0.50, confidence: 0.9 },
      { x: 0.55, y: 0.50, confidence: 0.9 },
      { x: 0.44, y: 0.70, confidence: 0.85 },
      { x: 0.56, y: 0.70, confidence: 0.85 },
      { x: 0.44, y: 0.90, confidence: 0.8 },
      { x: 0.56, y: 0.90, confidence: 0.8 }
    ];

    // Sitting
    const sitting = [
      { x: 0.50, y: 0.22, confidence: 0.9 },
      { x: 0.48, y: 0.20, confidence: 0.8 },
      { x: 0.52, y: 0.20, confidence: 0.8 },
      { x: 0.46, y: 0.22, confidence: 0.7 },
      { x: 0.54, y: 0.22, confidence: 0.7 },
      { x: 0.42, y: 0.32, confidence: 0.9 },
      { x: 0.58, y: 0.32, confidence: 0.9 },
      { x: 0.38, y: 0.45, confidence: 0.85 },
      { x: 0.62, y: 0.45, confidence: 0.85 },
      { x: 0.40, y: 0.55, confidence: 0.8 },
      { x: 0.60, y: 0.55, confidence: 0.8 },
      { x: 0.45, y: 0.55, confidence: 0.9 },
      { x: 0.55, y: 0.55, confidence: 0.9 },
      { x: 0.42, y: 0.58, confidence: 0.85 },
      { x: 0.58, y: 0.58, confidence: 0.85 },
      { x: 0.38, y: 0.90, confidence: 0.8 },
      { x: 0.62, y: 0.90, confidence: 0.8 }
    ];

    // Waving (left hand up, right hand at side)
    const waving = [
      { x: 0.50, y: 0.12, confidence: 0.9 },
      { x: 0.48, y: 0.10, confidence: 0.8 },
      { x: 0.52, y: 0.10, confidence: 0.8 },
      { x: 0.46, y: 0.12, confidence: 0.7 },
      { x: 0.54, y: 0.12, confidence: 0.7 },
      { x: 0.42, y: 0.22, confidence: 0.9 },
      { x: 0.58, y: 0.22, confidence: 0.9 },
      { x: 0.35, y: 0.12, confidence: 0.85 },
      { x: 0.62, y: 0.38, confidence: 0.85 },
      { x: 0.30, y: 0.04, confidence: 0.8 },
      { x: 0.64, y: 0.52, confidence: 0.8 },
      { x: 0.45, y: 0.50, confidence: 0.9 },
      { x: 0.55, y: 0.50, confidence: 0.9 },
      { x: 0.44, y: 0.70, confidence: 0.85 },
      { x: 0.56, y: 0.70, confidence: 0.85 },
      { x: 0.44, y: 0.90, confidence: 0.8 },
      { x: 0.56, y: 0.90, confidence: 0.8 }
    ];

    return [standing, walkLeft, standing, walkRight, armsUp, standing, sitting, standing, waving, standing];
  }

  _buildSleepingPose() {
    return [
      { x: 0.22, y: 0.85, confidence: 0.9 }, // 0: nose
      { x: 0.20, y: 0.83, confidence: 0.8 }, // 1: left_eye
      { x: 0.20, y: 0.87, confidence: 0.8 }, // 2: right_eye
      { x: 0.18, y: 0.82, confidence: 0.7 }, // 3: left_ear
      { x: 0.18, y: 0.88, confidence: 0.7 }, // 4: right_ear
      { x: 0.30, y: 0.80, confidence: 0.9 }, // 5: left_shoulder
      { x: 0.30, y: 0.90, confidence: 0.9 }, // 6: right_shoulder
      { x: 0.36, y: 0.78, confidence: 0.85 }, // 7: left_elbow
      { x: 0.36, y: 0.92, confidence: 0.85 }, // 8: right_elbow
      { x: 0.42, y: 0.76, confidence: 0.8 },  // 9: left_wrist
      { x: 0.42, y: 0.94, confidence: 0.8 },  // 10: right_wrist
      { x: 0.50, y: 0.82, confidence: 0.9 },  // 11: left_hip
      { x: 0.50, y: 0.88, confidence: 0.9 },  // 12: right_hip
      { x: 0.62, y: 0.81, confidence: 0.85 }, // 13: left_knee
      { x: 0.62, y: 0.89, confidence: 0.85 }, // 14: right_knee
      { x: 0.74, y: 0.80, confidence: 0.8 },  // 15: left_ankle
      { x: 0.74, y: 0.90, confidence: 0.8 }   // 16: right_ankle
    ];
  }

  _buildFallbackAmplitude(meanRssi) {
    const base = meanRssi != null ? Math.max(0, Math.min(1, 1 + meanRssi / 100)) : 0.55;
    return Array.from({ length: 30 }, (_, index) => Math.max(0, Math.min(1, base * (0.92 + (index % 5) * 0.02))));
  }

  _buildFallbackPhase() {
    return Array.from({ length: 30 }, (_, index) => Math.sin(index / 4) * 0.5);
  }

  _buildFallbackDoppler(motionEnergy) {
    const strength = Math.max(0, Math.min(1, motionEnergy || 0));
    return Array.from({ length: 16 }, (_, index) => Math.max(0, Math.min(1, strength * (0.5 + Math.sin(index / 3) * 0.5))));
  }

  // Generate a confidence heatmap from person positions
  generateConfidenceHeatmap(persons, cols, rows, roomWidth, roomDepth) {
    const positions = (persons || []).map(p => {
      if (!p.keypoints || p.keypoints.length < 13) return null;
      const hipX = (p.keypoints[11].x + p.keypoints[12].x) / 2;
      const hipY = (p.keypoints[11].y + p.keypoints[12].y) / 2;
      return {
        x: (hipX - 0.5) * roomWidth,
        z: (hipY - 0.5) * roomDepth,
        confidence: p.confidence
      };
    }).filter(Boolean);

    const map = new Float32Array(cols * rows);
    const cellW = roomWidth / cols;
    const cellD = roomDepth / rows;

    for (const pos of positions) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const cx = (c + 0.5) * cellW - roomWidth / 2;
          const cz = (r + 0.5) * cellD - roomDepth / 2;
          const dx = cx - pos.x;
          const dz = cz - pos.z;
          const dist = Math.sqrt(dx * dx + dz * dz);
          const conf = Math.exp(-dist * dist * 0.5) * pos.confidence;
          map[r * cols + c] = Math.max(map[r * cols + c], conf);
        }
      }
    }

    return map;
  }

  dispose() {
    this.demoPoses = [];
  }
}
