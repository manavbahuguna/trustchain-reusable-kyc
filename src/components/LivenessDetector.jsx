// components/LivenessDetector.jsx
// Real biometric liveness detection using MediaPipe FaceMesh
// Challenges: blink detection, head turn, smile detection
// No biometric data stored — liveness is a challenge-response only

import { useState, useEffect, useRef, useCallback } from 'react';

// ─── Metrics Storage ──────────────────────────────────────────────────────────
const METRICS_KEY = 'trustchain_metrics';

function saveAttempt(attempt) {
  const existing = JSON.parse(localStorage.getItem(METRICS_KEY) || '[]');
  existing.push(attempt);
  localStorage.setItem(METRICS_KEY, JSON.stringify(existing));
}

function loadAttempts() {
  return JSON.parse(localStorage.getItem(METRICS_KEY) || '[]');
}

function exportCSV() {
  const data = loadAttempts();
  if (data.length === 0) { alert('No data recorded yet.'); return; }
  const headers = ['person_id','device','challenge','attempt','result','time_seconds','is_spoof','timestamp'];
  const rows = data.map(d => headers.map(h => d[h] ?? '').join(','));
  const csv = [headers.join(','), ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `trustchain_metrics_${Date.now()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const CHALLENGES = [
  { id: 'blink',    label: 'Blink twice',        icon: '👁',  instruction: 'Please blink both eyes twice' },
  { id: 'smile',    label: 'Smile',               icon: '😊',  instruction: 'Please smile naturally' },
  { id: 'turn_left',label: 'Turn head left',      icon: '⬅️',  instruction: 'Slowly turn your head to the left' },
  { id: 'turn_right',label:'Turn head right',     icon: '➡️',  instruction: 'Slowly turn your head to the right' },
  { id: 'nod',      label: 'Nod your head',       icon: '⬆️',  instruction: 'Nod your head up and down once' },
];

// MediaPipe landmark indices
const LEFT_EYE  = [33,160,158,133,153,144];
const RIGHT_EYE = [362,385,387,263,373,380];
const MOUTH     = [61,291,0,17,269,405,61,185,40,39,37];
const MOUTH_TOP = 13, MOUTH_BOTTOM = 14;
const NOSE_TIP  = 1;

function eyeAspectRatio(landmarks, indices) {
  const p = i => landmarks[i];
  const dist = (a,b) => Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2);
  const vertical1 = dist(p(indices[1]), p(indices[5]));
  const vertical2 = dist(p(indices[2]), p(indices[4]));
  const horizontal = dist(p(indices[0]), p(indices[3]));
  return (vertical1 + vertical2) / (2.0 * horizontal);
}

function mouthAspectRatio(landmarks) {
  const p = i => landmarks[i];
  const dist = (a,b) => Math.sqrt((a.x-b.x)**2+(a.y-b.y)**2);
  return dist(p(MOUTH_TOP), p(MOUTH_BOTTOM)) /
    dist(p(MOUTH[0]), p(MOUTH[1]));
}

export default function LivenessDetector({ onComplete, onFail }) {
  const videoRef    = useRef(null);
  const canvasRef   = useRef(null);
  const faceRef     = useRef(null);
  const cameraRef   = useRef(null);
  const frameBuffer = useRef([]);
  const challengeState = useRef({
    blinkCount: 0, lastBlinkEAR: null, eyeClosed: false,
    smileDetected: false, turnLeftDetected: false,
    turnRightDetected: false, nodDetected: false,
    lastNoseY: null, nodDirection: null,
  });

 const [status, setStatus]           = useState('setup');
const [currentChallenge, setCurrentChallenge] = useState(0);
const [completed, setCompleted]     = useState([]);
const [faceDetected, setFaceDetected] = useState(false);
const [progress, setProgress]       = useState(0);
const [errorMsg, setErrorMsg]       = useState('');
const [metrics, setMetrics]         = useState(null);

// Metrics logger state
const [personId, setPersonId]       = useState('');
const [deviceName, setDeviceName]   = useState('');
const [sessionAttempts, setSessionAttempts] = useState([]);
const [spoofMode, setSpoofMode]     = useState(false);
const [spoofResult, setSpoofResult] = useState(null);
const challengeStartTime            = useRef(null);
const attemptNumber                 = useRef(1);

  // Pick 3 random challenges
  const challenges = useRef(
    [...CHALLENGES].sort(()=>Math.random()-0.5).slice(0,3)
  );

  const checkChallenge = useCallback((landmarks) => {
    if (!landmarks || landmarks.length < 468) return;
    const ch = challenges.current[currentChallenge];
    if (!ch) return;
    const st = challengeState.current;

    const leftEAR  = eyeAspectRatio(landmarks, LEFT_EYE);
    const rightEAR = eyeAspectRatio(landmarks, RIGHT_EYE);
    const avgEAR   = (leftEAR + rightEAR) / 2;
    const mar      = mouthAspectRatio(landmarks);
    const noseX    = landmarks[NOSE_TIP].x;
    const noseY    = landmarks[NOSE_TIP].y;

    setMetrics({ ear: avgEAR.toFixed(3), mar: mar.toFixed(3), noseX: noseX.toFixed(3) });

    let passed = false;

    if (ch.id === 'blink') {
      const EAR_THRESH = 0.21;
      if (avgEAR < EAR_THRESH && !st.eyeClosed) {
        st.eyeClosed = true;
      } else if (avgEAR >= EAR_THRESH && st.eyeClosed) {
        st.eyeClosed = false;
        st.blinkCount++;
        challengeState.current = { ...st };
      }
      if (st.blinkCount >= 2) passed = true;
    }

    if (ch.id === 'smile') {
      if (mar > 0.45) { st.smileDetected = true; }
      if (st.smileDetected) passed = true;
    }

    if (ch.id === 'turn_left') {
      if (noseX < 0.35) { st.turnLeftDetected = true; }
      if (st.turnLeftDetected) passed = true;
    }

    if (ch.id === 'turn_right') {
      if (noseX > 0.65) { st.turnRightDetected = true; }
      if (st.turnRightDetected) passed = true;
    }

    if (ch.id === 'nod') {
      if (st.lastNoseY !== null) {
        const diff = noseY - st.lastNoseY;
        if (diff > 0.02 && st.nodDirection !== 'down') st.nodDirection = 'down';
        if (diff < -0.02 && st.nodDirection === 'down') { st.nodDetected = true; }
      }
      st.lastNoseY = noseY;
      if (st.nodDetected) passed = true;
    }

    if (passed) {
      const timeTaken = challengeStartTime.current
    ? ((Date.now() - challengeStartTime.current) / 1000).toFixed(2)
    : 0;
  const attempt = {
    person_id: personId || 'unknown',
    device: deviceName || navigator.userAgent.split(')')[0].split('(')[1] || 'unknown',
    challenge: ch.id,
    attempt: attemptNumber.current++,
    result: 'PASS',
    time_seconds: timeTaken,
    is_spoof: false,
    timestamp: new Date().toISOString(),
  };
  saveAttempt(attempt);
  setSessionAttempts(prev => [...prev, attempt]);
  challengeStartTime.current = Date.now();
      const newCompleted = [...completed, ch.id];
      setCompleted(newCompleted);
      setProgress(Math.round((newCompleted.length / challenges.current.length) * 100));

      // Reset state for next challenge
      challengeState.current = {
        blinkCount:0, lastBlinkEAR:null, eyeClosed:false,
        smileDetected:false, turnLeftDetected:false,
        turnRightDetected:false, nodDetected:false,
        lastNoseY:null, nodDirection:null,
      };

      if (newCompleted.length >= challenges.current.length) {
        setStatus('passed');
        setTimeout(() => onComplete?.({
          passed: true,
          challenges: newCompleted,
          timestamp: Date.now(),
          livenessScore: 100,
        }), 800);
      } else {
        setCurrentChallenge(c => c + 1);
      }
    }
  }, [currentChallenge, completed, onComplete]);

  useEffect(() => {
    if (status !== 'running') return;
    let faceMeshInstance = null;
    let cameraInstance   = null;
    let timeout          = null;

    const load = async () => {
      try {
        const { FaceMesh } = await import('@mediapipe/face_mesh');
        const { Camera }   = await import('@mediapipe/camera_utils');

        faceMeshInstance = new FaceMesh({
          locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${f}`
        });

        faceMeshInstance.setOptions({
          maxNumFaces: 1,
          refineLandmarks: true,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.7,
        });

        faceMeshInstance.onResults(results => {
          if (!canvasRef.current || !videoRef.current) return;
          const ctx = canvasRef.current.getContext('2d');
          const { videoWidth: w, videoHeight: h } = videoRef.current;
          canvasRef.current.width  = w;
          canvasRef.current.height = h;
          ctx.clearRect(0, 0, w, h);
          ctx.drawImage(results.image, 0, 0, w, h);

          if (results.multiFaceLandmarks?.length > 0) {
            setFaceDetected(true);
            const lm = results.multiFaceLandmarks[0];

            // Draw face mesh overlay
            ctx.strokeStyle = 'rgba(13,200,138,0.4)';
            ctx.lineWidth = 0.5;
            for (const lmk of lm) {
              ctx.beginPath();
              ctx.arc(lmk.x*w, lmk.y*h, 1.5, 0, 2*Math.PI);
              ctx.fillStyle = 'rgba(13,200,138,0.7)';
              ctx.fill();
            }

            // Draw eye outline
            ctx.strokeStyle = 'rgba(255,200,0,0.8)';
            ctx.lineWidth = 1.5;
            [LEFT_EYE, RIGHT_EYE].forEach(eye => {
              ctx.beginPath();
              eye.forEach((idx,i) => {
                const pt = lm[idx];
                if (i===0) ctx.moveTo(pt.x*w, pt.y*h);
                else ctx.lineTo(pt.x*w, pt.y*h);
              });
              ctx.closePath();
              ctx.stroke();
            });

            checkChallenge(lm);
          } else {
            setFaceDetected(false);
          }
        });

        faceRef.current = faceMeshInstance;

        cameraInstance = new Camera(videoRef.current, {
          onFrame: async () => {
            if (faceMeshInstance && videoRef.current)
              await faceMeshInstance.send({ image: videoRef.current });
          },
          width: 640, height: 480,
        });

        await cameraInstance.start();
        cameraRef.current = cameraInstance;

        // 30 second timeout
        timeout = setTimeout(() => {
          setStatus('failed');
          setErrorMsg('Liveness check timed out. Please try again.');
          onFail?.({ reason: 'timeout' });
        }, 30000);

      } catch (e) {
        setErrorMsg('Failed to load face detection: ' + e.message);
        setStatus('failed');
      }
    };

    load();

    return () => {
      clearTimeout(timeout);
      cameraInstance?.stop?.();
      faceMeshInstance?.close?.();
    };
  }, [status, checkChallenge]);

  const startLiveness = () => {
  if (!personId.trim()) {
    alert('Please enter a Person ID before starting.');
    return;
  }
  challengeStartTime.current = Date.now();
  attemptNumber.current = 1;
  setStatus('running');
};

const recordSpoofAttack = (attackType, result) => {
  const attempt = {
    person_id: personId || 'unknown',
    device: deviceName || 'unknown',
    challenge: attackType,
    attempt: attemptNumber.current++,
    result: result,
    time_seconds: 0,
    is_spoof: true,
    timestamp: new Date().toISOString(),
  };
  saveAttempt(attempt);
  setSessionAttempts(prev => [...prev, attempt]);
  setSpoofResult(result);
  setTimeout(() => setSpoofResult(null), 1500);
};

  const retry = () => {
    challenges.current = [...CHALLENGES].sort(()=>Math.random()-0.5).slice(0,3);
    challengeState.current = {
      blinkCount:0, lastBlinkEAR:null, eyeClosed:false,
      smileDetected:false, turnLeftDetected:false,
      turnRightDetected:false, nodDetected:false,
      lastNoseY:null, nodDirection:null,
    };
    setCurrentChallenge(0);
    setCompleted([]);
    setProgress(0);
    setFaceDetected(false);
    setErrorMsg('');
    setStatus('running');
  };

  const ch = challenges.current[currentChallenge];

  return (
    <div style={styles.container}>
      <div style={styles.title}>🧬 Biometric Liveness Detection</div>
      <div style={styles.desc}>
        Proves you are a real person, not a photo or video replay.
        Complete the challenges below using your webcam.
      </div>

      {/* Challenge progress */}
      <div style={styles.challenges}>
        {challenges.current.map((c,i) => (
          <div key={c.id} style={{
            ...styles.challengeChip,
            background: completed.includes(c.id)
              ? 'rgba(52,199,123,0.15)'
              : i === currentChallenge && status==='running'
              ? 'rgba(13,158,138,0.15)'
              : 'rgba(255,255,255,0.04)',
            border: `1px solid ${completed.includes(c.id)
              ? 'rgba(52,199,123,0.4)'
              : i===currentChallenge && status==='running'
              ? 'rgba(13,158,138,0.4)'
              : 'rgba(255,255,255,0.08)'}`,
          }}>
            <span style={{fontSize:'18px'}}>{c.icon}</span>
            <span style={{fontSize:'12px',color: completed.includes(c.id)?'#34C77B':'#8EA5BA'}}>
              {completed.includes(c.id) ? '✓ ' : ''}{c.label}
            </span>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      <div style={styles.progressBar}>
        <div style={{...styles.progressFill, width:`${progress}%`}} />
      </div>

      {/* Video feed */}
      {(status==='running'||status==='passed') && (
        <div style={styles.videoWrap}>
          <video ref={videoRef} style={styles.video} autoPlay playsInline muted />
          <canvas ref={canvasRef} style={styles.canvas} />

          {/* Face detection indicator */}
          <div style={{
            ...styles.faceIndicator,
            background: faceDetected ? 'rgba(52,199,123,0.9)' : 'rgba(224,76,76,0.9)',
          }}>
            {faceDetected ? '✅ Face detected' : '❌ No face detected'}
          </div>

          {/* Current challenge overlay */}
          {status==='running' && ch && (
            <div style={styles.challengeOverlay}>
              <span style={{fontSize:'24px'}}>{ch.icon}</span>
              <span style={{fontSize:'13px',color:'#fff',marginLeft:'8px'}}>{ch.instruction}</span>
            </div>
          )}

          {/* Passed overlay */}
          {status==='passed' && (
            <div style={styles.passedOverlay}>
              <div style={{fontSize:'48px'}}>✅</div>
              <div style={{fontSize:'18px',fontWeight:'700',color:'#34C77B',marginTop:'8px'}}>Liveness Confirmed</div>
            </div>
          )}
        </div>
      )}

      {/* Debug metrics */}
      {metrics && status==='running' && (
        <div style={styles.metrics}>
          <span>EAR: {metrics.ear}</span>
          <span>MAR: {metrics.mar}</span>
          <span>Nose X: {metrics.noseX}</span>
        </div>
      )}

      {/* Status messages */}
      {errorMsg && <div style={styles.error}>{errorMsg}</div>}

      {/* Actions */}
      {status==='setup' && (
        <div>
          <div style={styles.setupTitle}>📋 Test Session Setup</div>
          <div style={styles.setupField}>
            <div style={styles.setupLabel}>Person ID (number)</div>
            <input
              style={styles.setupInput}
              type="number"
              placeholder="e.g. 1, 2, 3..."
              value={personId}
              onChange={e => setPersonId(e.target.value)}
            />
          </div>
          <div style={styles.setupField}>
            <div style={styles.setupLabel}>Device / Browser</div>
            <input
              style={styles.setupInput}
              type="text"
              placeholder="e.g. MacBook Chrome, iPhone Safari"
              value={deviceName}
              onChange={e => setDeviceName(e.target.value)}
            />
          </div>
          <button style={styles.btnPrimary} onClick={startLiveness}>
            📷 Start Liveness Check
          </button>
          <div style={styles.spoofSection}>
            <div style={styles.setupTitle}>🎭 Spoof Attack Testing</div>
            <div style={styles.setupLabel}>Record whether spoof attacks are accepted or rejected</div>
            <div style={styles.spoofGrid}>
              {['photo_attack','video_replay','partial_occlusion'].map(attack => (
                <div key={attack} style={styles.spoofCard}>
                  <div style={styles.spoofName}>
                    {attack==='photo_attack'?'📸 Photo':attack==='video_replay'?'📹 Video':'🫣 Partial'}
                  </div>
                  <div style={styles.spoofBtns}>
                    <button
                      style={{...styles.spoofBtn, background:'rgba(52,199,123,0.15)',color:'#34C77B'}}
                      onClick={()=>recordSpoofAttack(attack,'PASS')}>
                      Accepted
                    </button>
                    <button
                      style={{...styles.spoofBtn, background:'rgba(224,76,76,0.15)',color:'#FF8A8A'}}
                      onClick={()=>recordSpoofAttack(attack,'FAIL')}>
                      Rejected
                    </button>
                  </div>
                </div>
              ))}
            </div>
            {spoofResult && (
              <div style={{textAlign:'center',padding:'8px',color:spoofResult==='PASS'?'#34C77B':'#FF8A8A',fontSize:'13px',fontWeight:'600'}}>
                {spoofResult==='PASS'?'⚠️ Recorded as ACCEPTED':'✅ Recorded as REJECTED'}
              </div>
            )}
          </div>
          {sessionAttempts.length > 0 && (
            <div style={styles.attemptsTable}>
              <div style={styles.setupTitle}>📊 Session Data ({sessionAttempts.length} attempts)</div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>{['Person','Challenge','Result','Time','Spoof'].map(h=><th key={h} style={styles.th}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {sessionAttempts.slice(-10).reverse().map((a,i)=>(
                      <tr key={i}>
                        <td style={styles.td}>{a.person_id}</td>
                        <td style={styles.td}>{a.challenge}</td>
                        <td style={{...styles.td,color:a.result==='PASS'?'#34C77B':'#FF8A8A',fontWeight:'600'}}>{a.result}</td>
                        <td style={styles.td}>{a.time_seconds}s</td>
                        <td style={styles.td}>{a.is_spoof?'⚠️':'✅'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={styles.exportRow}>
                <button style={styles.exportBtn} onClick={exportCSV}>📥 Export CSV</button>
                <button
                  style={{...styles.exportBtn,background:'rgba(224,76,76,0.1)',color:'#FF8A8A'}}
                  onClick={()=>{if(confirm('Clear all data?')){localStorage.removeItem(METRICS_KEY);setSessionAttempts([]);}}}>
                  🗑 Clear Data
                </button>
                <span style={{fontSize:'11px',color:'#4A6172',fontFamily:'DM Mono,monospace'}}>
                  Total stored: {loadAttempts().length} attempts
                </span>
              </div>
            </div>
          )}
        </div>
      )}
      {status==='init' && (
        <button style={styles.btnPrimary} onClick={startLiveness}>
          📷 Start Liveness Check
        </button>
      )}
      {status==='failed' && (
        <button style={styles.btnPrimary} onClick={retry}>🔄 Try Again</button>
      )}
      {status==='passed' && (
        <div style={{...styles.successMsg}}>
          ✅ Liveness verified! Proceeding to biometric registration...
        </div>
      )}

      <div style={styles.privacyNote}>
        🔒 Video processed locally · No frames transmitted · No biometric templates stored
      </div>
    </div>
  );
}

const styles = {
  container: { padding:'0' },
  title: { fontFamily:'Syne,sans-serif', fontSize:'18px', fontWeight:'700', color:'#F0F5FA', marginBottom:'8px', display:'flex', alignItems:'center', gap:'8px' },
  desc: { fontSize:'13px', color:'#8EA5BA', lineHeight:'1.6', marginBottom:'16px' },
  challenges: { display:'flex', gap:'8px', flexWrap:'wrap', marginBottom:'12px' },
  challengeChip: { display:'flex', alignItems:'center', gap:'6px', padding:'8px 12px', borderRadius:'8px', transition:'all 0.3s' },
  progressBar: { height:'4px', background:'rgba(255,255,255,0.08)', borderRadius:'2px', marginBottom:'16px', overflow:'hidden' },
  progressFill: { height:'100%', background:'linear-gradient(90deg,#0D9E8A,#12C4AB)', borderRadius:'2px', transition:'width 0.4s ease' },
  videoWrap: { position:'relative', borderRadius:'12px', overflow:'hidden', marginBottom:'12px', border:'1px solid rgba(13,158,138,0.3)' },
  video: { width:'100%', display:'block', opacity:'0' },
  canvas: { position:'absolute', top:0, left:0, width:'100%', height:'100%' },
  faceIndicator: { position:'absolute', top:'10px', right:'10px', padding:'4px 10px', borderRadius:'12px', fontSize:'11px', fontWeight:'600', color:'#fff' },
  challengeOverlay: { position:'absolute', bottom:'12px', left:'50%', transform:'translateX(-50%)', background:'rgba(0,0,0,0.75)', backdropFilter:'blur(8px)', padding:'8px 16px', borderRadius:'20px', display:'flex', alignItems:'center', whiteSpace:'nowrap' },
  passedOverlay: { position:'absolute', inset:0, background:'rgba(0,0,0,0.7)', display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center' },
  metrics: { display:'flex', gap:'16px', fontSize:'11px', fontFamily:'DM Mono,monospace', color:'#4A6172', marginBottom:'12px', justifyContent:'center' },
  error: { background:'rgba(224,76,76,0.08)', border:'1px solid rgba(224,76,76,0.25)', borderLeft:'3px solid #E04C4C', borderRadius:'6px', padding:'10px 14px', fontSize:'13px', color:'#FF8A8A', marginBottom:'12px' },
  btnPrimary: { width:'100%', padding:'12px', background:'#0D9E8A', border:'none', borderRadius:'9px', fontFamily:'Syne,sans-serif', fontSize:'14px', fontWeight:'600', color:'#000', cursor:'pointer', marginBottom:'8px' },
  successMsg: { background:'rgba(52,199,123,0.08)', border:'1px solid rgba(52,199,123,0.2)', borderLeft:'3px solid #34C77B', borderRadius:'6px', padding:'10px 14px', fontSize:'13px', color:'#34C77B', marginBottom:'12px' },
  privacyNote: { textAlign:'center', fontSize:'10px', color:'#4A6172', fontFamily:'DM Mono,monospace', letterSpacing:'0.3px' },
  setupTitle: { fontFamily:'Syne,sans-serif', fontSize:'14px', fontWeight:'600', color:'#F0F5FA', marginBottom:'10px', marginTop:'16px' },
  setupField: { marginBottom:'12px' },
  setupLabel: { fontSize:'11px', color:'#4A6172', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'6px' },
  setupInput: { width:'100%', background:'#1C2B3A', border:'1px solid #1E3048', borderRadius:'6px', padding:'9px 12px', fontSize:'13px', color:'#F0F5FA', fontFamily:'DM Sans,sans-serif', outline:'none' },
  spoofSection: { marginTop:'20px', background:'rgba(224,76,76,0.05)', border:'1px solid rgba(224,76,76,0.15)', borderRadius:'10px', padding:'14px' },
  spoofGrid: { display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'8px', margin:'10px 0' },
  spoofCard: { background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)', borderRadius:'8px', padding:'10px', textAlign:'center' },
  spoofName: { fontSize:'12px', color:'#B8CDD8', marginBottom:'8px', fontWeight:'500' },
  spoofBtns: { display:'flex', flexDirection:'column', gap:'5px' },
  spoofBtn: { padding:'5px 8px', border:'none', borderRadius:'5px', fontSize:'11px', fontWeight:'600', cursor:'pointer' },
  attemptsTable: { marginTop:'16px', background:'rgba(28,43,58,0.6)', border:'1px solid #1E3048', borderRadius:'10px', padding:'14px' },
  tableWrap: { overflowX:'auto', marginBottom:'10px' },
  table: { width:'100%', borderCollapse:'collapse', fontSize:'11px' },
  th: { padding:'6px 10px', textAlign:'left', color:'#4A6172', textTransform:'uppercase', letterSpacing:'0.4px', borderBottom:'1px solid #1E3048', fontFamily:'Syne,sans-serif' },
  td: { padding:'6px 10px', color:'#B8CDD8', borderBottom:'1px solid rgba(255,255,255,0.04)', fontFamily:'DM Mono,monospace' },
  exportRow: { display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap', marginTop:'8px' },
  exportBtn: { padding:'7px 14px', background:'rgba(13,158,138,0.1)', border:'1px solid rgba(13,158,138,0.2)', borderRadius:'6px', color:'#0D9E8A', fontSize:'12px', fontWeight:'600', cursor:'pointer', fontFamily:'Syne,sans-serif' },
};

