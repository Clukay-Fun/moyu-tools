// 3D 折叠预览：面板网格直接由 model 的 2D 轮廓（含圆角、孔槽、插舌）挤出，
// 折叠层级来自 panel.parent / hinge / order；展开态（fold = 0）与 2D 坐标一一对应。
import { contourToCommands, tessellateContour, centroid } from './geometry.js'

const PAPER_RGB = { 'corrugated-e': 0xd8c39d, 'corrugated-b': 0xcdb488, cardboard: 0xf2f0ea }

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2
}

function buildShapePath(THREE, target, contour, offset) {
  const commands = contourToCommands(contour)
  for (const command of commands) {
    const x = command.x - offset[0]
    const y = command.y - offset[1]
    if (command.type === 'M') target.moveTo(x, y)
    else if (command.type === 'L') target.lineTo(x, y)
    else target.absarc(command.cx - offset[0], command.cy - offset[1], command.r, command.a1, command.a2, command.clockwise)
  }
  target.closePath()
}

function makePaperTexture(THREE) {
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size, size)
  let seed = 7
  const random = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let index = 0; index < 2600; index += 1) {
    const shade = 225 + Math.floor(random() * 30)
    context.strokeStyle = `rgba(${shade}, ${shade - 6}, ${shade - 14}, 0.55)`
    context.lineWidth = 0.6 + random() * 0.8
    const x = random() * size
    const y = random() * size
    context.beginPath()
    context.moveTo(x, y)
    context.lineTo(x + (random() - 0.5) * 12, y + (random() - 0.5) * 3)
    context.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.repeat.set(1 / 60, 1 / 60) // 每 60 mm 重复一次，与面板毫米坐标绑定
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

export async function createFoldPreview(container, model) {
  const THREE = await import('three')
  const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js')
  await new Promise((resolve) => requestAnimationFrame(resolve))
  const { width: stageWidth, height: stageHeight } = container.getBoundingClientRect()
  if (stageWidth <= 0 || stageHeight <= 0) throw new Error('3D 画布没有有效尺寸')

  let renderer
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
  } catch (error) {
    throw new Error(`WebGL 上下文创建失败：${error.message || '当前设备或驱动不支持'}`)
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(stageWidth, stageHeight)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.setClearColor(0xffffff, 0)
  renderer.domElement.setAttribute('role', 'img')
  renderer.domElement.setAttribute('aria-label', '刀模三维折叠预览')
  container.replaceChildren(renderer.domElement)

  try {
    return buildScene()
  } catch (error) {
    renderer.dispose()
    renderer.forceContextLoss?.()
    renderer.domElement.remove()
    throw error
  }

  function buildScene() {
  const scene = new THREE.Scene()
  const { minX, minY, maxX, maxY } = model.bounds
  const extent = Math.max(maxX - minX, maxY - minY)
  const camera = new THREE.PerspectiveCamera(32, stageWidth / stageHeight, 1, extent * 40)
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8d8f9c, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 1.9)
  key.position.set(-extent, extent * 1.6, extent)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 0.6)
  fill.position.set(extent, extent * 0.4, -extent)
  scene.add(fill)

  const root = new THREE.Group()
  // 2D 坐标 (x 右, y 下) → 世界 (X 右, −Z)，厚度挤出方向 → 世界 +Y
  root.rotation.x = -Math.PI / 2
  root.position.set(-(minX + maxX) / 2, 0, (minY + maxY) / 2)
  scene.add(root)

  const thickness = model.params.thickness
  const texture = makePaperTexture(THREE)
  const material = new THREE.MeshStandardMaterial({
    color: PAPER_RGB[model.params.material] || PAPER_RGB['corrugated-e'],
    map: texture,
    roughness: 0.92,
    metalness: 0,
    side: THREE.DoubleSide
  })
  const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x6b5a3e, transparent: true, opacity: 0.55 })

  const folders = []
  const assemblies = []
  for (const part of model.parts) {
    const anchor = part.anchor || [(part.paperBounds.minX + part.paperBounds.maxX) / 2, (part.paperBounds.minY + part.paperBounds.maxY) / 2]
    const partPivot = new THREE.Group()
    partPivot.position.set(part.layout.x + anchor[0], part.layout.y + anchor[1], 0)
    const partInner = new THREE.Group()
    partInner.position.set(-anchor[0], -anchor[1], 0)
    partPivot.add(partInner)
    root.add(partPivot)
    if (part.assemble?.mode === 'pose') {
      const target = model.parts.find((entry) => entry.id === part.assemble.over) || part
      const from = new THREE.Vector3(part.layout.x + anchor[0], part.layout.y + anchor[1], 0)
      part.assemble.poses.forEach((pose, index) => {
        let pivot = partPivot
        if (index > 0) {
          pivot = new THREE.Group()
          pivot.position.copy(from)
          pivot.add(partInner.clone())
          root.add(pivot)
        }
        const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(pose.rotX || 0), THREE.MathUtils.degToRad(pose.rotY || 0), THREE.MathUtils.degToRad(pose.rotZ || 0), 'ZYX'
        ))
        assemblies.push({
          pivot, from,
          to: new THREE.Vector3(target.layout.x + pose.x, target.layout.y + pose.y, pose.z),
          mode: 'pose', quat, flip: false, slideFrom: [0, 0], motion: pose.motion || 'lift'
        })
      })
    } else if (part.assemble) {
      const target = model.parts.find((entry) => entry.id === part.assemble.over)
      if (target) {
        const targetAnchor = target.anchor || [(target.paperBounds.minX + target.paperBounds.maxX) / 2, (target.paperBounds.minY + target.paperBounds.maxY) / 2]
        assemblies.push({
          pivot: partPivot,
          from: new THREE.Vector3(part.layout.x + anchor[0], part.layout.y + anchor[1], 0),
          to: new THREE.Vector3(target.layout.x + targetAnchor[0], target.layout.y + targetAnchor[1], part.assemble.lift || 0),
          flip: Boolean(part.assemble.flip),
          mode: part.assemble.mode || 'drop',
          slideFrom: part.assemble.slideFrom || [0, 0]
        })
      }
    }

    const nodes = new Map()
    const pending = [...part.panels]
    let guard = 0
    while (pending.length && guard < 1000) {
      guard += 1
      const panel = pending.shift()
      if (panel.parent && !nodes.has(panel.parent)) {
        pending.push(panel)
        continue
      }
      const origin = panel.hinge ? panel.hinge.a : [0, 0]
      const pivot = new THREE.Group()
      if (panel.parent) {
        const parentNode = nodes.get(panel.parent)
        pivot.position.set(origin[0] - parentNode.origin[0], origin[1] - parentNode.origin[1], 0)
        parentNode.pivot.add(pivot)
      } else {
        pivot.position.set(origin[0], origin[1], 0)
        partInner.add(pivot)
      }
      const shape = new THREE.Shape()
      buildShapePath(THREE, shape, panel.contour, origin)
      for (const hole of panel.holes || []) {
        const holePath = new THREE.Path()
        buildShapePath(THREE, holePath, hole, origin)
        shape.holes.push(holePath)
      }
      const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 12 })
      const mesh = new THREE.Mesh(geometry, material)
      pivot.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), edgeMaterial)
      pivot.add(edges)
      nodes.set(panel.id, { pivot, origin })

      if (panel.hinge && panel.angle) {
        const axis = new THREE.Vector3(panel.hinge.b[0] - panel.hinge.a[0], panel.hinge.b[1] - panel.hinge.a[1], 0).normalize()
        const [cx, cy] = centroid(tessellateContour(panel.contour))
        const toward = new THREE.Vector3(cx - origin[0], cy - origin[1], 0)
        // 折叠方向：面板朝纸面正面（+z，挤出侧）折入；轴向按叉积 z 分量定号
        if (axis.clone().cross(toward).z < 0) axis.negate()
        folders.push({ pivot, axis, angle: THREE.MathUtils.degToRad(panel.angle), order: panel.order || 1 })
      }
    }
  }
  const stepCount = Math.max(1, ...folders.map((entry) => entry.order))

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.12
  controls.target.set(0, thickness, 0)
  const resetView = () => {
    camera.position.set(extent * 0.45, extent * 0.95, extent * 1.15)
    controls.target.set(0, thickness, 0)
    controls.update()
  }
  resetView()

  let fold = 0
  let assembly = 0
  const flipAxis = new THREE.Vector3(1, 0, 0)
  const identityQuat = new THREE.Quaternion()
  // 装配分三段：先垂直抬起，再平移并翻转到目标上方，最后垂直落下
  const applyAssembly = () => {
    for (const entry of assemblies) {
      const hover = entry.to.z + extent * 0.35
      const lift = easeInOut(Math.min(1, assembly / 0.3))
      const travel = easeInOut(Math.max(0, Math.min(1, (assembly - 0.3) / 0.4)))
      const final = easeInOut(Math.max(0, (assembly - 0.7) / 0.3))
      if (entry.mode === 'slide') {
        // 滑入：抬起 → 平移到目标侧前方并降到目标高度 → 沿滑入方向推入
        const stageX = entry.to.x + entry.slideFrom[0]
        const stageY = entry.to.y + entry.slideFrom[1]
        const x = assembly <= 0.7 ? entry.from.x + (stageX - entry.from.x) * travel : stageX + (entry.to.x - stageX) * final
        const y = assembly <= 0.7 ? entry.from.y + (stageY - entry.from.y) * travel : stageY + (entry.to.y - stageY) * final
        const z = assembly <= 0.3 ? hover * lift : hover + (entry.to.z - hover) * travel
        entry.pivot.position.set(x, y, z)
        entry.pivot.quaternion.identity()
        continue
      }
      if (entry.motion === 'ground') {
        // 原地立起（前半段），再沿地面平移到位（后半段），不抬起
        const stand = easeInOut(Math.min(1, assembly / 0.5))
        const move = easeInOut(Math.max(0, (assembly - 0.5) / 0.5))
        entry.pivot.position.set(
          entry.from.x + (entry.to.x - entry.from.x) * move,
          entry.from.y + (entry.to.y - entry.from.y) * move,
          entry.to.z * stand
        )
        entry.pivot.quaternion.slerpQuaternions(identityQuat, entry.quat, stand)
        continue
      }
      const x = entry.from.x + (entry.to.x - entry.from.x) * travel
      const y = entry.from.y + (entry.to.y - entry.from.y) * travel
      const z = assembly <= 0.7 ? hover * lift : hover + (entry.to.z - hover) * final
      entry.pivot.position.set(x, y, z)
      if (entry.mode === 'pose') entry.pivot.quaternion.slerpQuaternions(identityQuat, entry.quat, travel)
      else entry.pivot.quaternion.setFromAxisAngle(flipAxis, entry.flip ? Math.PI * travel : 0)
    }
  }
  const applyFold = () => {
    for (const entry of folders) {
      const local = Math.max(0, Math.min(1, fold * stepCount - (entry.order - 1)))
      entry.pivot.quaternion.setFromAxisAngle(entry.axis, easeInOut(local) * entry.angle)
    }
  }
  applyFold()
  applyAssembly()

  let frame = 0
  const render = () => {
    frame = requestAnimationFrame(render)
    controls.update()
    renderer.render(scene, camera)
  }
  render()

  const resizeObserver = new ResizeObserver(() => {
    if (!container.clientWidth || !container.clientHeight) return
    renderer.setSize(container.clientWidth, container.clientHeight)
    camera.aspect = container.clientWidth / container.clientHeight
    camera.updateProjectionMatrix()
  })
  resizeObserver.observe(container)

  return {
    setFold(value) {
      fold = Math.max(0, Math.min(1, value))
      applyFold()
    },
    setAssembly(value) {
      assembly = Math.max(0, Math.min(1, value))
      applyAssembly()
    },
    resetView,
    dispose() {
      cancelAnimationFrame(frame)
      resizeObserver.disconnect()
      controls.dispose()
      scene.traverse((object) => {
        object.geometry?.dispose?.()
      })
      material.dispose()
      edgeMaterial.dispose()
      texture.dispose()
      renderer.dispose()
      renderer.forceContextLoss?.()
      // 只移除自己的画布：过期实例的 dispose 不能清掉新实例已挂上的画布
      renderer.domElement.remove()
    }
  }
  }
}
