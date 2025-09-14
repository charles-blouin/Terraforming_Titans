// Planet Visualizer
// Lightweight wrapper around three.js to show a simple red sphere
// and overlay planet data from the running game.

(function () {
  class PlanetVisualizer {
    constructor(resourcesRef, terraformingRef) {
      // Dependencies (game globals)
      this.resources = resourcesRef;
      this.terraforming = terraformingRef;

      // Cached UI elements
      this.elements = {
        container: null,
        overlay: null,
      };

      // three.js members
      this.renderer = null;
      this.scene = null;
      this.camera = null;
      this.sphere = null;
      this.sunLight = null;
      this.sunMesh = null;
      this.cityLightsGroup = null;
      this.cityLights = [];
      this.maxCityLights = 200; // Total available city lights
      this.lastCityLightCount = -1;

      // Render sizing
      this.width = 0;
      this.height = 0;
      this.planetAngle = 0;       // radians
      this.rotationSpeed = 0.01;  // fallback when no dayNightCycle
      this.cameraDistance = 3.5;  // distance from planet center
      this.cameraHeight = 0.0;    // equatorial geosynchronous view
      this.lastCraterFactorKey = null; // memoize texture state
      this.craterLayer = null;    // cached crater alpha/color layer (static shape)
      this.cloudLayer = null;     // cached green cloud layer (static shape)

      // Bind methods
      this.animate = this.animate.bind(this);
      this.onResize = this.onResize.bind(this);
      this.applySlidersToGame = this.applySlidersToGame.bind(this);
      this.syncSlidersFromGame = this.syncSlidersFromGame.bind(this);
      this.updateSliderValueLabels = this.updateSliderValueLabels.bind(this);

      // Debug controls cache
      this.debug = {
        enabled: (function() {
          // Default true unless explicitly false
          return !(window['debug_planet-visualizer'] === false);
        })(),
        container: null,
        rows: {}, // id -> { range, number }
      };

      // Visualizer-local state (does not affect game)
      this.viz = {
        illum: 1,
        pop: 0,
        kpa: { co2: 0, o2: 0, inert: 0, h2o: 0, ch4: 0 },
        coverage: { water: 0, life: 0 },
      };
    }

    init() {
      // Cache DOM elements once
      const container = document.getElementById('planet-visualizer');
      const overlay = document.getElementById('planet-visualizer-overlay');
      this.elements.container = container;
      this.elements.overlay = overlay;

      // Setup three.js
      this.width = container.clientWidth;
      this.height = container.clientHeight;

      this.renderer = new THREE.WebGLRenderer({ antialias: true });
      this.renderer.setPixelRatio(window.devicePixelRatio || 1);
      this.renderer.setSize(this.width, this.height);
      this.renderer.setClearColor(0x000000, 1);
      container.appendChild(this.renderer.domElement);

      this.scene = new THREE.Scene();
      this.camera = new THREE.PerspectiveCamera(45, this.width / this.height, 0.1, 1000);
      this.camera.position.z = this.cameraDistance;
      this.camera.position.y = this.cameraHeight;
      this.camera.lookAt(0, 0, 0);

      // Sun (directional) + a small visible marker sphere
      const initialIllum = (currentPlanetParameters.celestialParameters.starLuminosity ?? 1) || 1;
      this.sunLight = new THREE.DirectionalLight(0xffffff, initialIllum);
      this.sunLight.position.set(5, 3, 2); // direction toward the planet
      this.scene.add(this.sunLight);
      this.scene.add(new THREE.AmbientLight(0x404040));

      const sunGeom = new THREE.SphereGeometry(0.15, 16, 16);
      const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff5a6 }); // emissive-looking
      this.sunMesh = new THREE.Mesh(sunGeom, sunMat);
      this.sunMesh.position.copy(this.sunLight.position).multiplyScalar(1.6);
      this.scene.add(this.sunMesh);

      const geometry = new THREE.SphereGeometry(1, 32, 32);
      const material = new THREE.MeshStandardMaterial({ color: 0xaa2222 });
      this.sphere = new THREE.Mesh(geometry, material);
      this.scene.add(this.sphere);

      // Pre-create a pool of tiny city lights attached to the planet
      this.createCityLights();

      window.addEventListener('resize', this.onResize);

      if (this.debug.enabled) {
        this.buildDebugControls();
        this.syncSlidersFromGame();
      }

      this.updateOverlayText();
      // Create initial crater texture matching current pressure
      this.updateSurfaceTextureFromPressure(true);
      // Ensure lights match initial population
      this.updateCityLights();
      this.animate();
    }

    onResize() {
      if (!this.elements.container) return;
      const w = this.elements.container.clientWidth;
      const h = this.elements.container.clientHeight;
      if (w === 0 || h === 0) return;
      this.width = w;
      this.height = h;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    }

    animate() {
      // Planet rotation + geosynchronous camera orbit
      let angle;
      if (typeof dayNightCycle !== 'undefined' && dayNightCycle && typeof dayNightCycle.getDayProgress === 'function') {
        const progress = dayNightCycle.getDayProgress(); // 0..1 over a day
        angle = (progress % 1) * Math.PI * 2;
      } else {
        // Fallback: simple constant spin if cycle unavailable
        this.planetAngle += this.rotationSpeed;
        angle = this.planetAngle;
      }
      this.planetAngle = angle;
      if (this.sphere) {
        this.sphere.rotation.y = angle;
      }
      // Camera follows the same angular position (geostationary)
      const ang = angle;
      this.camera.position.set(
        Math.sin(ang) * this.cameraDistance,
        this.cameraHeight,
        Math.cos(ang) * this.cameraDistance
      );
      this.camera.lookAt(0, 0, 0);

      // Keep overlay up to date
      this.updateOverlayText();
      // Update crater appearance if total pressure changed meaningfully
      this.updateSurfaceTextureFromPressure();
      // Adjust city lights based on population
      this.updateCityLights();

      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(this.animate);
    }

    updateOverlayText() {
      const overlay = this.elements.overlay;
      if (!overlay) return;

      // Population from resources
      const colonists = this.resources.colony.colonists.value;

      // CO2 pressure from atmospheric CO2 mass and current world params
      const co2MassTon = this.resources.atmospheric.carbonDioxide.value;
      // Read static body params from current planet parameters to avoid
      // depending on terraforming initialization timing
      const g = currentPlanetParameters.celestialParameters.gravity;
      const radiusKm = currentPlanetParameters.celestialParameters.radius;

      // calculateAtmosphericPressure expects tons, m/s^2, and radius in km
      const pa = calculateAtmosphericPressure(co2MassTon, g, radiusKm);
      const kPa = pa / 1000;

      const popText = formatNumber(colonists);

      // Show two decimals for kPa without formatNumber to keep it clear
      const kPaText = (Math.abs(kPa) < 1000) ? kPa.toFixed(2) : kPa.toExponential(2);

      overlay.textContent = `Pop: ${popText}\nCO2: ${kPaText} kPa`;
    }

    // ---------- Debug UI ----------
    buildDebugControls() {
      const host = document.createElement('div');
      host.className = 'planet-visualizer-debug';

      const grid = document.createElement('div');
      grid.className = 'pv-grid';
      host.appendChild(grid);

      const makeRow = (id, label, min, max, step) => {
        const l = document.createElement('div');
        l.className = 'pv-row-label';
        l.textContent = label;
        const range = document.createElement('input');
        range.type = 'range';
        range.min = String(min); range.max = String(max); range.step = String(step);
        range.id = `pv-${id}`;
        const valWrap = document.createElement('div');
        valWrap.className = 'pv-row-value';
        const number = document.createElement('input');
        number.type = 'number';
        number.min = String(min); number.max = String(max); number.step = String(step);
        valWrap.appendChild(number);
        grid.appendChild(l); grid.appendChild(range); grid.appendChild(valWrap);
        this.debug.rows[id] = { range, number };
        const syncFromRange = () => { number.value = range.value; this.applySlidersToGame(); };
        const syncFromNumber = () => { range.value = number.value; this.applySlidersToGame(); };
        range.addEventListener('input', syncFromRange);
        number.addEventListener('input', syncFromNumber);
      };

      // Illumination (star luminosity multiplier)
      makeRow('illum', 'Illumination', 0.0, 3.0, 0.01);
      // Population (colonists)
      makeRow('pop', 'Population', 0, 1000000, 1);
      // Gas pressures (kPa) – clamped to 0..100
      makeRow('co2', 'CO2 (kPa)', 0, 100, 0.1);
      makeRow('o2',  'O2 (kPa)',  0, 100, 0.1);
      makeRow('inert','Inert (kPa)', 0, 100, 0.1);
      makeRow('h2o', 'H2O vap. (kPa)', 0, 100, 0.1);
      makeRow('ch4', 'CH4 (kPa)', 0, 100, 0.1);

      // Coverage sliders (percent)
      makeRow('waterCov', 'Water (%)', 0, 100, 0.1);
      makeRow('lifeCov',  'Life (%)',  0, 100, 0.1);

      const controls = document.createElement('div');
      controls.className = 'pv-controls';
      const btnSync = document.createElement('button');
      btnSync.textContent = 'Set to game parameters';
      // Use arrow to ensure correct context
      btnSync.addEventListener('click', () => this.syncSlidersFromGame());
      controls.appendChild(btnSync);
      host.appendChild(controls);

      // Place debug panel directly after the canvas container
      this.elements.container.insertAdjacentElement('afterend', host);
      this.debug.container = host;
    }

    updateSliderValueLabels() {
      const r = this.debug.rows; if (!r) return;
      const setVal = (id, v) => { if (r[id]) r[id].number.value = String(v); if (r[id]) r[id].range.value = String(v); };
      setVal('illum', Number(r.illum.range.value));
      setVal('pop',   Number(r.pop.range.value));
      setVal('co2',   Number(r.co2.range.value));
      setVal('o2',    Number(r.o2.range.value));
      setVal('inert', Number(r.inert.range.value));
      setVal('h2o',   Number(r.h2o.range.value));
      setVal('ch4',   Number(r.ch4.range.value));
      setVal('waterCov', Number(r.waterCov.range.value));
      setVal('lifeCov',  Number(r.lifeCov.range.value));
    }

    // ---------- City lights ----------
    createCityLights() {
      if (!this.sphere) return;
      this.cityLightsGroup = new THREE.Group();
      this.sphere.add(this.cityLightsGroup);

      const geom = new THREE.SphereGeometry(0.015, 8, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffd37a }); // warm city light

      // Generate deterministic positions for stability across frames
      for (let i = 0; i < this.maxCityLights; i++) {
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;           // longitude
        const phi = Math.acos(2 * v - 1);        // latitude from +Z
        const r = 1.005;                         // slightly above surface
        const x = r * Math.sin(phi) * Math.cos(theta);
        const y = r * Math.cos(phi);
        const z = r * Math.sin(phi) * Math.sin(theta);
        const m = new THREE.Mesh(geom, mat.clone());
        m.position.set(x, y, z);
        m.visible = false;
        this.cityLightsGroup.add(m);
        this.cityLights.push(m);
      }
    }

    getCurrentPopulation() {
      if (this.debug.enabled) {
        return this.viz.pop || 0;
      }
      return (this.resources?.colony?.colonists?.value) || 0;
    }

    updateCityLights() {
      const pop = this.getCurrentPopulation();
      const target = Math.max(0, Math.min(this.maxCityLights, Math.floor((pop / 1_000_000) * this.maxCityLights)));
      // We still iterate each frame to evaluate day/night culling even if target unchanged
      this.lastCityLightCount = target;

      // Direction from planet center to the sun (world space)
      const sunDir = this.sunLight ? this.sunLight.position.clone().normalize() : new THREE.Vector3(1,0,0);
      const tmp = new THREE.Vector3();

      for (let i = 0; i < this.maxCityLights; i++) {
        const m = this.cityLights[i];
        if (!m) continue;
        // Desired base visibility from population count
        const baseVisible = i < target;
        if (!baseVisible) { m.visible = false; continue; }
        // Compute world-space normal for this point
        m.getWorldPosition(tmp);
        tmp.normalize(); // since planet at origin
        const daySide = tmp.dot(sunDir) > 0; // facing the sun
        m.visible = !daySide; // lights only on the night side
      }
    }

    // Convert pressure (kPa) -> mass (tons) using same physics as pressure calc
    massFromPressureKPa(kPa, g, radiusKm) {
      const pPa = Math.max(0, kPa) * 1000;
      const surfaceArea = 4 * Math.PI * Math.pow(radiusKm * 1000, 2);
      return (pPa * surfaceArea) / (1000 * g);
    }

    applySlidersToGame() {
      this.updateSliderValueLabels();
      const r = this.debug.rows;
      const cel = currentPlanetParameters.celestialParameters;

      const clampFrom = (pair) => {
        const n = pair.number; const range = pair.range;
        let v = Number(n.value);
        const min = Number(n.min); const max = Number(n.max);
        if (isNaN(v)) v = min;
        if (!isNaN(min)) v = Math.max(min, v);
        if (!isNaN(max)) v = Math.min(max, v);
        n.value = String(v); range.value = String(v);
        return v;
      };

      // Illumination (visualizer only)
      const illum = clampFrom(r.illum);
      this.viz.illum = illum;
      if (this.sunLight) this.sunLight.intensity = illum;

      // Population (visualizer only)
      const pop = Math.max(0, Math.floor(clampFrom(r.pop)));
      this.viz.pop = pop;

      // Gas pressures (visualizer only, store as kPa)
      this.viz.kpa.co2   = clampFrom(r.co2);
      this.viz.kpa.o2    = clampFrom(r.o2);
      this.viz.kpa.inert = clampFrom(r.inert);
      this.viz.kpa.h2o   = clampFrom(r.h2o);
      this.viz.kpa.ch4   = clampFrom(r.ch4);

      // Coverage sliders (visual only)
      this.viz.coverage.water = clampFrom(r.waterCov);
      this.viz.coverage.life  = clampFrom(r.lifeCov);

      // Surface should reflect pressure immediately
      this.updateSurfaceTextureFromPressure(true);
    }

    // Read game state and set sliders accordingly
    syncSlidersFromGame() {
      const r = this.debug.rows;
      const cel = currentPlanetParameters.celestialParameters;

      // Illumination
      const illum = cel.starLuminosity ?? 1;
      r.illum.range.value = String(illum);
      r.illum.number.value = String(illum);
      // Population
      const popNow = this.resources.colony.colonists.value || 0;
      r.pop.range.value = String(popNow);
      r.pop.number.value = String(popNow);

      const toKPa = (massTon) => calculateAtmosphericPressure(massTon || 0, cel.gravity, cel.radius) / 1000;
      const clamp100 = (v) => Math.max(0, Math.min(100, v));
      const atm = this.resources.atmospheric;
      r.co2.range.value   = String(clamp100(toKPa(atm.carbonDioxide.value)));
      r.o2.range.value    = String(clamp100(toKPa(atm.oxygen.value)));
      r.inert.range.value = String(clamp100(toKPa(atm.inertGas.value)));
      r.h2o.range.value   = String(clamp100(toKPa(atm.atmosphericWater.value)));
      r.ch4.range.value   = String(clamp100(toKPa(atm.atmosphericMethane.value)));
      r.co2.number.value   = r.co2.range.value;
      r.o2.number.value    = r.o2.range.value;
      r.inert.number.value = r.inert.range.value;
      r.h2o.number.value   = r.h2o.range.value;
      r.ch4.number.value   = r.ch4.range.value;

      // Coverage from terraforming (fractions to percent)
      const waterFrac = (typeof calculateAverageCoverage === 'function' && typeof terraforming !== 'undefined')
        ? calculateAverageCoverage(terraforming, 'liquidWater') : 0;
      const lifeFrac  = (typeof calculateAverageCoverage === 'function' && typeof terraforming !== 'undefined')
        ? calculateAverageCoverage(terraforming, 'biomass') : 0;
      r.waterCov.range.value = String((waterFrac * 100).toFixed(2));
      r.waterCov.number.value = r.waterCov.range.value;
      r.lifeCov.range.value = String((lifeFrac * 100).toFixed(2));
      r.lifeCov.number.value = r.lifeCov.range.value;
      
      this.updateSliderValueLabels();
      // Update visualizer-local state and visuals (no game mutation)
      this.viz.illum = illum;
      this.viz.pop = popNow;
      this.viz.kpa = {
        co2: Number(r.co2.range.value),
        o2: Number(r.o2.range.value),
        inert: Number(r.inert.range.value),
        h2o: Number(r.h2o.range.value),
        ch4: Number(r.ch4.range.value),
      };
      this.viz.coverage = {
        water: Number(r.waterCov.range.value),
        life: Number(r.lifeCov.range.value),
      };
      if (this.sunLight) this.sunLight.intensity = this.viz.illum;
      this.updateSurfaceTextureFromPressure(true);
    }

    // ---------- Crater texture generation ----------
    computeTotalPressureKPa() {
      // When debug is enabled, use visualizer kPa values; otherwise use actual game resources
      if (this.debug.enabled) {
        const k = this.viz.kpa;
        return (k.co2 + k.o2 + k.inert + k.h2o + k.ch4);
      }
      const cel = currentPlanetParameters.celestialParameters;
      let totalPa = 0;
      const atm = this.resources.atmospheric || {};
      for (const key in atm) {
        const mass = atm[key]?.value || 0;
        totalPa += calculateAtmosphericPressure(mass, cel.gravity, cel.radius) || 0;
      }
      return totalPa / 1000; // kPa
    }

    updateSurfaceTextureFromPressure(force = false) {
      const kPa = this.computeTotalPressureKPa();
      // 0 kPa -> 1 (full craters), 100 kPa+ -> 0 (few craters)
      const factor = Math.max(0, Math.min(1, 1 - (kPa / 100)));
      const water = (this.viz.coverage?.water || 0) / 100;
      const life = (this.viz.coverage?.life || 0) / 100;
      // Memo key rounded to 2 decimals to avoid churn
      const key = `${factor.toFixed(2)}|${water.toFixed(2)}|${life.toFixed(2)}`;
      if (!force && key === this.lastCraterFactorKey) return;
      this.lastCraterFactorKey = key;

      const tex = this.generateCraterTexture(factor);
      if (this.sphere && this.sphere.material) {
        this.sphere.material.map = tex;
        this.sphere.material.needsUpdate = true;
      }
    }

    generateCraterTexture(strength) {
      // strength in [0,1]: 1 = very cratered, 0 = smooth
      const w = 512, h = 256;

      // Build crater layer once with fixed random distribution
      if (!this.craterLayer) {
        const craterCanvas = document.createElement('canvas');
        craterCanvas.width = w; craterCanvas.height = h;
        const cctx = craterCanvas.getContext('2d');
        // Build at maximum detail (strength = 1) and keep as overlay
        const maxCount = Math.floor(250 * 1 + 50);
        for (let i = 0; i < maxCount; i++) {
          const x = Math.random() * w;
          const y = Math.random() * h;
          const r = (4 + Math.random() * 18) * (0.5 + 1);
          // Outer dark rim (alpha baked into layer)
          const g1 = cctx.createRadialGradient(x, y, r * 0.6, x, y, r);
          g1.addColorStop(0, 'rgba(0,0,0,0)');
          g1.addColorStop(1, 'rgba(0,0,0,0.25)');
          cctx.fillStyle = g1;
          cctx.beginPath();
          cctx.arc(x, y, r, 0, Math.PI * 2);
          cctx.fill();

          // Inner lighter floor
          const g2 = cctx.createRadialGradient(x, y, 0, x, y, r * 0.6);
          g2.addColorStop(0, 'rgba(255,255,255,0.08)');
          g2.addColorStop(1, 'rgba(255,255,255,0)');
          cctx.fillStyle = g2;
          cctx.beginPath();
          cctx.arc(x, y, r * 0.7, 0, Math.PI * 2);
          cctx.fill();
        }
        this.craterLayer = craterCanvas;
      }

      // Compose base + craterLayer scaled by strength (no change of shape)
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');

      // Water coverage tints toward blue
      const mix = (a, b, t) => {
        const ah = parseInt(a.slice(1), 16), bh = parseInt(b.slice(1), 16);
        const ar = (ah >> 16) & 255, ag = (ah >> 8) & 255, ab = ah & 255;
        const br = (bh >> 16) & 255, bg = (bh >> 8) & 255, bb = bh & 255;
        const r = Math.round(ar + (br - ar) * t);
        const g = Math.round(ag + (bg - ag) * t);
        const b2 = Math.round(ab + (bb - ab) * t);
        return `rgb(${r},${g},${b2})`;
      };
      const waterT = (this.viz.coverage?.water || 0) / 100;
      const topCol = mix('#8a2a2a', '#2a4d8a', waterT);
      const botCol = mix('#6e1f1f', '#1f3a6e', waterT);
      const base = ctx.createLinearGradient(0, 0, 0, h);
      base.addColorStop(0, topCol);
      base.addColorStop(1, botCol);
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, w, h);

      if (strength > 0) {
        ctx.globalAlpha = Math.max(0, Math.min(1, strength));
        ctx.drawImage(this.craterLayer, 0, 0);
        ctx.globalAlpha = 1;
      }

      // Green cloud layer scales with life coverage
      const lifeT = (this.viz.coverage?.life || 0) / 100;
      if (lifeT > 0) {
        if (!this.cloudLayer) {
          const cloud = document.createElement('canvas');
          cloud.width = w; cloud.height = h;
          const cctx = cloud.getContext('2d');
          const blobs = 180;
          for (let i = 0; i < blobs; i++) {
            const x = Math.random() * w;
            const y = Math.random() * h;
            const r = 12 + Math.random() * 48;
            const g = cctx.createRadialGradient(x, y, 0, x, y, r);
            g.addColorStop(0, 'rgba(5, 241, 80, 0.88)');
            g.addColorStop(1, 'rgba(5, 255, 84, 0)');
            cctx.fillStyle = g;
            cctx.beginPath(); cctx.arc(x, y, r, 0, Math.PI * 2); cctx.fill();
          }
          this.cloudLayer = cloud;
        }
        ctx.globalAlpha = Math.max(0, Math.min(1, lifeT));
        ctx.drawImage(this.cloudLayer, 0, 0);
        ctx.globalAlpha = 1;
      }

      const texture = new THREE.CanvasTexture(canvas);
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.needsUpdate = true;
      return texture;
    }
  }

  // Expose and initialize from game lifecycle
  window.PlanetVisualizer = PlanetVisualizer;

  // Helper the game can call after resources/terraforming exist
  window.initializePlanetVisualizerUI = function initializePlanetVisualizerUI() {
    window.planetVisualizer = new PlanetVisualizer(window.resources, window.terraforming);
    window.planetVisualizer.init();
  };
})();
