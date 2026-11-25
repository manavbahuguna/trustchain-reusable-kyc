// components/RiskScoring.jsx
// Risk scoring engine for financial institutions
// Returns 0-100 score based on verification history, device signals, behavioral patterns

import { useState, useCallback } from 'react';
import { loadCredentials } from '../utils/identity.js';

// ─── Risk Factors ─────────────────────────────────────────────────────────────

function computeRiskScore(identity, credentials, options = {}) {
  const factors = [];
  let totalScore = 0;
  let totalWeight = 0;

  const now = Date.now();
  const DAY = 24 * 3600 * 1000;

  // 1. KYC Level (weight: 30)
  const kycLevel = identity?.kycLevel || 0;
  const kycScore = (kycLevel / 3) * 100;
  factors.push({
    name: 'KYC Level',
    score: kycScore,
    weight: 30,
    detail: `Level ${kycLevel}/3 — ${['Unverified','Basic','Enhanced','Full'][kycLevel]}`,
    icon: '🪪',
    color: kycScore > 66 ? '#34C77B' : kycScore > 33 ? '#F5A623' : '#E04C4C',
  });
  totalScore += kycScore * 30; totalWeight += 30;

  // 2. Identity Age (weight: 15) — older = more trusted
  const ageMs = identity ? now - identity.createdAt : 0;
  const ageDays = ageMs / DAY;
  const ageScore = Math.min(100, (ageDays / 90) * 100); // max score at 90 days
  factors.push({
    name: 'Identity Age',
    score: ageScore,
    weight: 15,
    detail: ageDays < 1 ? 'New identity (< 1 day)' : `${Math.floor(ageDays)} days old`,
    icon: '📅',
    color: ageScore > 66 ? '#34C77B' : ageScore > 33 ? '#F5A623' : '#E04C4C',
  });
  totalScore += ageScore * 15; totalWeight += 15;

  // 3. Blockchain Anchoring (weight: 20)
  const chainScore = identity?.onChain ? 100 : 20;
  factors.push({
    name: 'Blockchain Anchored',
    score: chainScore,
    weight: 20,
    detail: identity?.onChain ? 'DID anchored on Polygon Amoy' : 'Local only — not on-chain',
    icon: '⛓',
    color: chainScore > 66 ? '#34C77B' : '#E04C4C',
  });
  totalScore += chainScore * 20; totalWeight += 20;

  // 4. Credential Count (weight: 10)
  const credCount = credentials.length;
  const credScore = Math.min(100, credCount * 25);
  factors.push({
    name: 'Verifiable Credentials',
    score: credScore,
    weight: 10,
    detail: `${credCount} credential${credCount!==1?'s':''} issued`,
    icon: '📜',
    color: credScore > 66 ? '#34C77B' : credScore > 33 ? '#F5A623' : '#E04C4C',
  });
  totalScore += credScore * 10; totalWeight += 10;

  // 5. Credential Freshness (weight: 10)
  let freshnessScore = 0;
  if (credentials.length > 0) {
    const latest = Math.max(...credentials.map(c => c.issuedAt || 0));
    const daysSince = (now - latest) / DAY;
    freshnessScore = Math.max(0, 100 - (daysSince / 30) * 100);
  }
  factors.push({
    name: 'Credential Freshness',
    score: freshnessScore,
    weight: 10,
    detail: credentials.length > 0
      ? `Last issued ${Math.floor((now - Math.max(...credentials.map(c=>c.issuedAt||0)))/DAY)} days ago`
      : 'No credentials yet',
    icon: '🔄',
    color: freshnessScore > 66 ? '#34C77B' : freshnessScore > 33 ? '#F5A623' : '#E04C4C',
  });
  totalScore += freshnessScore * 10; totalWeight += 10;

  // 6. WebAuthn Algorithm Strength (weight: 10)
  const algoScore = identity?.algorithm === -7 ? 100 : identity?.algorithm === -257 ? 70 : 50;
  factors.push({
    name: 'Key Algorithm',
    score: algoScore,
    weight: 10,
    detail: identity?.algorithm === -7
      ? 'ES256 — ECDSA P-256 (optimal)'
      : identity?.algorithm === -257
      ? 'RS256 — RSA PKCS1 (good)'
      : 'Unknown algorithm',
    icon: '🔑',
    color: algoScore > 66 ? '#34C77B' : '#F5A623',
  });
  totalScore += algoScore * 10; totalWeight += 10;

  // 7. Device Attestation (weight: 5)
  const attScore = identity?.attestationFormat === 'packed' ? 100
    : identity?.attestationFormat === 'tpm' ? 95
    : identity?.attestationFormat === 'android-key' ? 90
    : identity?.attestationFormat === 'none' ? 50 : 60;
  factors.push({
    name: 'Attestation Format',
    score: attScore,
    weight: 5,
    detail: `Format: ${identity?.attestationFormat || 'unknown'}`,
    icon: '🔐',
    color: attScore > 66 ? '#34C77B' : '#F5A623',
  });
  totalScore += attScore * 5; totalWeight += 5;

  const finalScore = totalWeight > 0 ? Math.round(totalScore / totalWeight) : 0;

  // Risk tier
  const tier = finalScore >= 80 ? { label:'LOW RISK', color:'#34C77B', bg:'rgba(52,199,123,0.1)' }
    : finalScore >= 60 ? { label:'MEDIUM RISK', color:'#F5A623', bg:'rgba(245,166,35,0.1)' }
    : finalScore >= 40 ? { label:'ELEVATED RISK', color:'#FF8A8A', bg:'rgba(224,76,76,0.1)' }
    : { label:'HIGH RISK', color:'#E04C4C', bg:'rgba(224,76,76,0.15)' };

  // Transaction limits based on score
  const limits = finalScore >= 80
    ? { daily:'₹10,00,000', single:'₹5,00,000', international: true }
    : finalScore >= 60
    ? { daily:'₹2,00,000', single:'₹50,000', international: false }
    : finalScore >= 40
    ? { daily:'₹25,000', single:'₹10,000', international: false }
    : { daily:'₹5,000', single:'₹2,000', international: false };

  return { score: finalScore, tier, factors, limits };
}

// ─── Gauge Component ──────────────────────────────────────────────────────────

function ScoreGauge({ score }) {
  const angle = (score / 100) * 180 - 90; // -90 to +90 degrees
  const color = score >= 80 ? '#34C77B' : score >= 60 ? '#F5A623' : score >= 40 ? '#FF8A8A' : '#E04C4C';

  return (
    <svg viewBox="0 0 200 110" style={{ width:'100%', maxWidth:'240px', margin:'0 auto', display:'block' }}>
      {/* Background arc */}
      <path d="M 20 100 A 80 80 0 0 1 180 100" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="16" strokeLinecap="round"/>
      {/* Score arc */}
      <path
        d="M 20 100 A 80 80 0 0 1 180 100"
        fill="none"
        stroke={color}
        strokeWidth="16"
        strokeLinecap="round"
        strokeDasharray={`${(score/100)*251.2} 251.2`}
        style={{filter:`drop-shadow(0 0 6px ${color}88)`, transition:'stroke-dasharray 1s ease'}}
      />
      {/* Zone markers */}
      {[0,40,60,80,100].map(v => {
        const a = (v/100)*180 - 90;
        const r = 80;
        const cx = 100 + r * Math.cos((a-90)*Math.PI/180);
        const cy = 100 + r * Math.sin((a-90)*Math.PI/180);
        return <circle key={v} cx={cx} cy={cy} r="3" fill="rgba(255,255,255,0.2)"/>;
      })}
      {/* Needle */}
      <line
        x1="100" y1="100"
        x2={100 + 55*Math.cos((angle-90)*Math.PI/180)}
        y2={100 + 55*Math.sin((angle-90)*Math.PI/180)}
        stroke={color} strokeWidth="3" strokeLinecap="round"
        style={{transition:'all 1s ease', filter:`drop-shadow(0 0 4px ${color})`}}
      />
      <circle cx="100" cy="100" r="6" fill={color}/>
      {/* Score text */}
      <text x="100" y="82" textAnchor="middle" fill={color} fontSize="28" fontWeight="700" fontFamily="Syne,sans-serif">{score}</text>
      <text x="100" y="95" textAnchor="middle" fill="#8EA5BA" fontSize="10" fontFamily="DM Sans,sans-serif">/ 100</text>
      {/* Labels */}
      <text x="18" y="112" fill="#4A6172" fontSize="9" fontFamily="DM Sans">HIGH</text>
      <text x="167" y="112" fill="#4A6172" fontSize="9" fontFamily="DM Sans">LOW</text>
    </svg>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function RiskScoring({ identity }) {
  const [result, setResult]   = useState(null);
  const [loading, setLoading] = useState(false);
  const [verifyDID, setVerifyDID] = useState('');

  const runScoring = useCallback(async (targetIdentity) => {
    setLoading(true);
    await new Promise(r => setTimeout(r, 800));
    const credentials = loadCredentials();
    const score = computeRiskScore(targetIdentity, credentials);
    setResult(score);
    setLoading(false);
  }, []);

  const handleVerifyExternal = useCallback(async () => {
    if (!verifyDID.trim()) return;
    setLoading(true);
    await new Promise(r => setTimeout(r, 1200));
    // Simulate external DID lookup
    const mockIdentity = {
      kycLevel: Math.floor(Math.random()*3)+1,
      createdAt: Date.now() - Math.random()*90*24*3600*1000,
      onChain: Math.random() > 0.3,
      algorithm: -7,
      attestationFormat: 'packed',
    };
    const score = computeRiskScore(mockIdentity, []);
    setResult(score);
    setLoading(false);
  }, [verifyDID]);

  return (
    <div>
      <div style={S.title}>📊 Risk Scoring Engine</div>
      <div style={S.desc}>
        Financial institution risk assessment. Computes a 0-100 trust score
        based on KYC level, identity age, blockchain anchoring, credentials,
        and cryptographic algorithm strength.
      </div>

      {/* My Identity Score */}
      {identity && (
        <div style={S.card}>
          <div style={S.cardTitle}>Your Identity Risk Score</div>
          <button style={S.btn} onClick={()=>runScoring(identity)} disabled={loading}>
            {loading ? '⟳ Computing...' : '📊 Compute My Risk Score'}
          </button>
        </div>
      )}

      {/* External DID */}
      <div style={S.card}>
        <div style={S.cardTitle}>Score External DID (Institution View)</div>
        <input
          style={S.input}
          placeholder="did:webauthn:abc123..."
          value={verifyDID}
          onChange={e=>setVerifyDID(e.target.value)}
        />
        {identity && (
          <button style={{...S.btn, background:'transparent', border:'1px solid rgba(13,158,138,0.3)', color:'#0D9E8A', fontSize:'12px', padding:'6px 12px', marginBottom:'8px'}}
            onClick={()=>setVerifyDID(identity.did)}>
            Use my DID
          </button>
        )}
        <button style={S.btn} onClick={handleVerifyExternal} disabled={loading||!verifyDID.trim()}>
          {loading ? '⟳ Scoring...' : '🔍 Score This DID'}
        </button>
      </div>

      {/* Results */}
      {result && (
        <div style={S.results}>
          {/* Gauge */}
          <div style={{...S.tier, background: result.tier.bg, borderColor: result.tier.color+'44'}}>
            <ScoreGauge score={result.score} />
            <div style={{textAlign:'center', marginTop:'4px'}}>
              <span style={{
                fontFamily:'Syne,sans-serif', fontSize:'16px', fontWeight:'700',
                color: result.tier.color, letterSpacing:'1px',
              }}>{result.tier.label}</span>
            </div>
          </div>

          {/* Transaction Limits */}
          <div style={S.limitsCard}>
            <div style={S.sectionTitle}>Recommended Transaction Limits</div>
            <div style={S.limitsGrid}>
              <div style={S.limitItem}>
                <div style={S.limitLabel}>Daily Limit</div>
                <div style={{...S.limitValue, color: result.tier.color}}>{result.limits.daily}</div>
              </div>
              <div style={S.limitItem}>
                <div style={S.limitLabel}>Single Transaction</div>
                <div style={{...S.limitValue, color: result.tier.color}}>{result.limits.single}</div>
              </div>
              <div style={S.limitItem}>
                <div style={S.limitLabel}>International</div>
                <div style={{...S.limitValue, color: result.limits.international?'#34C77B':'#E04C4C'}}>
                  {result.limits.international ? '✅ Allowed' : '❌ Blocked'}
                </div>
              </div>
            </div>
          </div>

          {/* Factor breakdown */}
          <div style={S.sectionTitle}>Factor Breakdown</div>
          {result.factors.map((f,i) => (
            <div key={i} style={S.factor}>
              <div style={S.factorHeader}>
                <span style={{fontSize:'16px'}}>{f.icon}</span>
                <div style={{flex:1}}>
                  <div style={S.factorName}>{f.name}
                    <span style={S.factorWeight}> ×{f.weight}%</span>
                  </div>
                  <div style={S.factorDetail}>{f.detail}</div>
                </div>
                <div style={{...S.factorScore, color: f.color}}>{Math.round(f.score)}</div>
              </div>
              <div style={S.barBg}>
                <div style={{...S.barFill, width:`${f.score}%`, background:f.color}} />
              </div>
            </div>
          ))}

          {/* Decision */}
          <div style={{
            ...S.decision,
            background: result.score>=60 ? 'rgba(52,199,123,0.08)' : 'rgba(224,76,76,0.08)',
            borderColor: result.score>=60 ? 'rgba(52,199,123,0.25)' : 'rgba(224,76,76,0.25)',
            color: result.tier.color,
          }}>
            {result.score >= 80 ? '✅ APPROVED — Full banking services available.'
              : result.score >= 60 ? '⚠️ CONDITIONALLY APPROVED — Standard limits apply.'
              : result.score >= 40 ? '⚠️ RESTRICTED — Enhanced monitoring required.'
              : '❌ REJECTED — Insufficient trust score for onboarding.'}
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  title: { fontFamily:'Syne,sans-serif', fontSize:'18px', fontWeight:'700', color:'#F0F5FA', marginBottom:'8px' },
  desc: { fontSize:'13px', color:'#8EA5BA', lineHeight:'1.6', marginBottom:'20px' },
  card: { background:'rgba(28,43,58,0.6)', border:'1px solid #1E3048', borderRadius:'10px', padding:'16px', marginBottom:'14px' },
  cardTitle: { fontSize:'13px', fontWeight:'600', color:'#B8CDD8', marginBottom:'10px', fontFamily:'Syne,sans-serif' },
  btn: { width:'100%', padding:'10px', background:'#0D9E8A', border:'none', borderRadius:'8px', fontFamily:'Syne,sans-serif', fontSize:'13px', fontWeight:'600', color:'#000', cursor:'pointer', marginTop:'4px' },
  input: { width:'100%', background:'#1C2B3A', border:'1px solid #1E3048', borderRadius:'6px', padding:'9px 12px', fontSize:'13px', color:'#F0F5FA', fontFamily:'DM Sans,sans-serif', outline:'none', marginBottom:'8px' },
  results: { marginTop:'4px' },
  tier: { border:'1px solid', borderRadius:'12px', padding:'16px', marginBottom:'14px' },
  limitsCard: { background:'rgba(28,43,58,0.6)', border:'1px solid #1E3048', borderRadius:'10px', padding:'16px', marginBottom:'14px' },
  limitsGrid: { display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'8px', marginTop:'8px' },
  limitItem: { textAlign:'center', padding:'10px 6px', background:'rgba(255,255,255,0.03)', borderRadius:'8px' },
  limitLabel: { fontSize:'10px', color:'#4A6172', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'4px' },
  limitValue: { fontSize:'13px', fontWeight:'600', fontFamily:'DM Mono,monospace' },
  sectionTitle: { fontSize:'12px', fontWeight:'600', color:'#8EA5BA', textTransform:'uppercase', letterSpacing:'0.5px', marginBottom:'10px', fontFamily:'Syne,sans-serif' },
  factor: { background:'rgba(28,43,58,0.6)', border:'1px solid #1E3048', borderRadius:'8px', padding:'12px', marginBottom:'8px' },
  factorHeader: { display:'flex', alignItems:'flex-start', gap:'10px', marginBottom:'8px' },
  factorName: { fontSize:'13px', fontWeight:'500', color:'#F0F5FA' },
  factorWeight: { fontSize:'11px', color:'#4A6172', fontFamily:'DM Mono,monospace' },
  factorDetail: { fontSize:'11px', color:'#8EA5BA', marginTop:'2px' },
  factorScore: { fontSize:'18px', fontWeight:'700', fontFamily:'DM Mono,monospace', minWidth:'36px', textAlign:'right' },
  barBg: { height:'4px', background:'rgba(255,255,255,0.06)', borderRadius:'2px', overflow:'hidden' },
  barFill: { height:'100%', borderRadius:'2px', transition:'width 0.8s ease' },
  decision: { border:'1px solid', borderRadius:'8px', padding:'12px 16px', fontSize:'14px', fontWeight:'600', marginTop:'4px' },
};
