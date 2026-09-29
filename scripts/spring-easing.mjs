// 弹簧缓动生成：阻尼弹簧的阶跃响应 → CSS linear()，时长取稳定到 ±0.3% 的时间（末点直接跳到 1，误差大了长距离移动会在最后一帧闪一下）。
// 只给「移动到新位置」的东西用（选中高亮、滑块）；即时反馈（浮层、提示、进场）用 --ease-out，
// 从静止起步的弹簧开头太慢（ζ 0.9 时 t80 = 0.53），不适合点了就要出现的东西。
// 公式与 onetake 动效库 OM.spring(tau, zeta, omega) 相同；改参数后重跑，把输出贴回 styles/00-foundation.css。
//   node scripts/spring-easing.mjs
function spring(tau, zeta, omega) {
  if (tau <= 0) return 0
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta)
    return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + (zeta * omega / wd) * Math.sin(wd * tau))
  }
  if (zeta === 1) return 1 - Math.exp(-omega * tau) * (1 + omega * tau)
  const q = omega * Math.sqrt(zeta * zeta - 1), r1 = -zeta * omega + q, r2 = -zeta * omega - q
  return 1 - (r2 * Math.exp(r1 * tau) - r1 * Math.exp(r2 * tau)) / (r2 - r1)
}

function settle(zeta, omega, eps = 0.003) {
  let last = 0
  for (let i = 1; i <= 5000; i += 1) { const t = i / 1000; if (Math.abs(1 - spring(t, zeta, omega)) > eps) last = t }
  return last
}

const presets = {
  // 落位：约 1.5% 过冲再回弹。过冲按距离等比放大，导航从首页滑到设置有 480px，
  // ζ 0.68（5.4%）会冲过头 26px，所以取 0.8
  land: { zeta: 0.8, omega: 26 },
}

for (const [name, { zeta, omega }] of Object.entries(presets)) {
  const duration = Math.round(settle(zeta, omega) * 1000)
  const n = 28
  const points = []
  let peak = 0
  let t80 = null
  for (let i = 0; i <= n; i += 1) {
    const u = i / n
    const v = i === n ? 1 : spring(u * duration / 1000, zeta, omega)
    peak = Math.max(peak, v)
    points.push(Number(v.toFixed(4)))
  }
  for (let i = 0; i <= 1000; i += 1) if (t80 === null && spring(i / 1000 * duration / 1000, zeta, omega) >= 0.8) t80 = i / 1000
  console.log(`  /* ζ ${zeta} · ω ${omega} · t80 ${t80.toFixed(2)} · 过冲 ${((peak - 1) * 100).toFixed(1)}% */`)
  console.log(`  --dur-spring-${name}: ${duration}ms;`)
  console.log(`  --ease-spring-${name}: linear(${points.join(', ')});`)
}
