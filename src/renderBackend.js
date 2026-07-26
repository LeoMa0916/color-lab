import { smoothCurveLut } from "./curveMath.js";

export function detectRenderBackend(environment = globalThis) {
  const navigatorObject = environment.navigator;
  if (navigatorObject?.gpu && environment.isSecureContext !== false) {
    return {
      id: "webgpu",
      label: "WebGPU",
      previewLimit: 1600,
      gpu: true,
    };
  }
  try {
    const canvas = environment.document?.createElement?.("canvas");
    if (canvas?.getContext?.("webgl2")) {
      return {
        id: "webgl2",
        label: "WebGL 2",
        previewLimit: 1280,
        gpu: true,
      };
    }
  } catch {
    // Capability probing must never prevent the CPU fallback.
  }
  return {
    id: "worker-cpu",
    label: "Worker CPU",
    previewLimit: 960,
    gpu: false,
  };
}

export function recommendedPreviewSide(backend, deviceMemory = 4, mobile = false) {
  if (mobile) return Math.min(960, backend.previewLimit);
  if (deviceMemory <= 2) return Math.min(960, backend.previewLimit);
  if (deviceMemory <= 4) return Math.min(1280, backend.previewLimit);
  return backend.previewLimit;
}

const WEBGPU_SHADER = `
@group(0) @binding(0) var<storage, read> inputPixels: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputPixels: array<u32>;
@group(0) @binding(2) var<storage, read> params: array<f32>;
@group(0) @binding(3) var<storage, read> curves: array<f32>;

fn saturate(value: f32) -> f32 { return clamp(value, 0.0, 1.0); }
fn smoothstep01(start: f32, end: f32, value: f32) -> f32 {
  let amount = saturate((value - start) / max(0.00001, end - start));
  return amount * amount * (3.0 - 2.0 * amount);
}
fn hash(value: u32) -> f32 {
  var state = value ^ 0x9e3779b9u;
  state = (state ^ (state >> 16u)) * 0x21f0aaadu;
  state = (state ^ (state >> 15u)) * 0x735a2d97u;
  state = state ^ (state >> 15u);
  return f32(state) / 4294967295.0 - 0.5;
}
fn curve(channel: u32, value: f32) -> f32 {
  let code = u32(clamp(round(value * 255.0), 0.0, 255.0));
  return curves[channel * 256u + code];
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
  let index = invocation.x;
  let width = u32(params[0]);
  let height = u32(params[1]);
  if (index >= width * height) { return; }
  let packed = inputPixels[index];
  var color = vec3<f32>(
    f32(packed & 255u),
    f32((packed >> 8u) & 255u),
    f32((packed >> 16u) & 255u)
  ) / 255.0;
  let alpha = (packed >> 24u) & 255u;
  let temperature = params[2] / 255.0 * 0.55;
  let tint = params[3] / 255.0;
  color += vec3<f32>(temperature + tint * 0.32, tint * -0.42, -temperature + tint * 0.28);
  var light = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  var adjusted = saturate(light * exp2(params[4]));
  let highlightWeight = smoothstep01(0.42, 0.96, adjusted);
  let shadowWeight = 1.0 - smoothstep01(0.04, 0.58, adjusted);
  let whiteWeight = smoothstep01(0.68, 1.0, adjusted);
  let blackWeight = 1.0 - smoothstep01(0.0, 0.34, adjusted);
  adjusted += (1.0 - adjusted) * max(params[6], 0.0) / 100.0 * highlightWeight * 0.52;
  adjusted += adjusted * min(params[6], 0.0) / 100.0 * highlightWeight * 0.42;
  adjusted += (1.0 - adjusted) * max(params[7], 0.0) / 100.0 * shadowWeight * 0.42;
  adjusted += adjusted * min(params[7], 0.0) / 100.0 * shadowWeight * 0.72;
  adjusted += (1.0 - adjusted) * max(params[8], 0.0) / 100.0 * whiteWeight * 0.72;
  adjusted += adjusted * min(params[8], 0.0) / 100.0 * whiteWeight * 0.34;
  adjusted += (1.0 - adjusted) * max(params[9], 0.0) / 100.0 * blackWeight * 0.24;
  adjusted += adjusted * min(params[9], 0.0) / 100.0 * blackWeight * 0.86;
  color += vec3<f32>(adjusted - light);
  light = dot(color, vec3<f32>(0.2126, 0.7152, 0.0722));
  let maximum = max(color.r, max(color.g, color.b));
  let minimum = min(color.r, min(color.g, color.b));
  let chroma = select(0.0, (maximum - minimum) / maximum, maximum > 0.0001);
  let vibrance = params[11] / 100.0;
  let colorFactor = (1.0 + vibrance * select(0.82, 1.0 - chroma, vibrance > 0.0) * 0.9)
    * (1.0 + params[12] / 100.0);
  color = vec3<f32>(light) + (color - vec3<f32>(light)) * colorFactor;
  let contrast = params[5];
  let contrastFactor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
  color = (color * 255.0 - vec3<f32>(128.0)) * contrastFactor / 255.0
    + vec3<f32>(128.0 / 255.0);
  let grainAmount = params[13];
  let highlightResponse = params[17] / 100.0;
  let grainWeight = (0.82 + (1.0 - light) * 0.36)
    * (1.0 - smoothstep01(0.58, 0.98, light) * (1.0 - highlightResponse));
  let pixelX = index % width;
  let pixelY = index / width;
  let grainSize = max(1.0, params[14] * f32(max(width, height)) / 1600.0);
  let cellX = u32(floor(f32(pixelX) / grainSize));
  let cellY = u32(floor(f32(pixelY) / grainSize));
  let seed = u32(params[18]);
  let coarse = hash(cellX ^ (cellY * 0x27d4eb2du) ^ seed);
  let fine = hash(index ^ seed ^ 0x68bc21ebu);
  let roughness = params[15] / 100.0;
  let baseNoise = coarse * (1.0 - roughness * 0.58) + fine * roughness * 0.72;
  let amplitude = grainAmount * 2.15 * grainWeight / 255.0;
  let colorRatio = params[16] / 100.0;
  let redNoise = hash(cellX ^ (cellY * 0x45d9f3bu) ^ seed ^ 0x1f123bb5u) * amplitude * colorRatio;
  let blueNoise = hash(cellX ^ (cellY * 0x21f0aaadu) ^ seed ^ 0x5f356495u) * amplitude * colorRatio;
  let luminanceNoise = baseNoise * amplitude;
  color += vec3<f32>(
    luminanceNoise + redNoise,
    luminanceNoise - (redNoise + blueNoise) * 0.28,
    luminanceNoise + blueNoise
  );
  color = vec3<f32>(
    curve(1u, curve(0u, saturate(color.r))),
    curve(2u, curve(0u, saturate(color.g))),
    curve(3u, curve(0u, saturate(color.b)))
  );
  let red = u32(clamp(round(color.r * 255.0), 0.0, 255.0));
  let green = u32(clamp(round(color.g * 255.0), 0.0, 255.0));
  let blue = u32(clamp(round(color.b * 255.0), 0.0, 255.0));
  outputPixels[index] = red | (green << 8u) | (blue << 16u) | (alpha << 24u);
}
`;

class WebGpuBasicRenderer {
  constructor() {
    this.initialization = null;
  }

  async initialize() {
    if (!this.initialization) {
      this.initialization = (async () => {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        if (!adapter) throw new Error("WebGPU adapter 不可用");
        const device = await adapter.requestDevice();
        const module = device.createShaderModule({ code: WEBGPU_SHADER });
        const pipeline = device.createComputePipeline({
          layout: "auto",
          compute: { module, entryPoint: "main" },
        });
        return { device, pipeline };
      })();
    }
    return this.initialization;
  }

  async render(payload) {
    if (
      payload.settings.texture
      || payload.settings.clarity
      || payload.settings.dehaze
    ) {
      throw new Error("多尺度细节需要 Worker");
    }
    const { device, pipeline } = await this.initialize();
    const bytes = new Uint8ClampedArray(payload.data);
    const packed = new Uint32Array(bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ));
    const params = Float32Array.from([
      payload.width,
      payload.height,
      payload.settings.temperature || 0,
      payload.settings.tint || 0,
      payload.settings.exposure || 0,
      payload.settings.contrast || 0,
      payload.settings.highlights || 0,
      payload.settings.shadows || 0,
      payload.settings.whites || 0,
      payload.settings.blacks || 0,
      payload.settings.dehaze || 0,
      payload.settings.vibrance || 0,
      payload.settings.saturation || 0,
      payload.settings.grain || 0,
      payload.settings.grainSize || 1,
      payload.settings.grainRoughness || 50,
      payload.settings.grainColor || 12,
      payload.settings.grainHighlights || 25,
      payload.settings.grainSeed || 1847,
    ]);
    const curveData = new Float32Array(1024);
    ["master", "red", "green", "blue"].forEach((channel, channelIndex) => {
      const lut = smoothCurveLut(payload.curves[channel]);
      for (let code = 0; code < 256; code += 1) {
        curveData[channelIndex * 256 + code] = lut[code] / 255;
      }
    });
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const input = device.createBuffer({ size: packed.byteLength, usage });
    const output = device.createBuffer({ size: packed.byteLength, usage });
    const paramBuffer = device.createBuffer({
      size: Math.ceil(params.byteLength / 16) * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const curveBuffer = device.createBuffer({
      size: curveData.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const readback = device.createBuffer({
      size: packed.byteLength,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    device.queue.writeBuffer(input, 0, packed);
    device.queue.writeBuffer(paramBuffer, 0, params);
    device.queue.writeBuffer(curveBuffer, 0, curveData);
    const bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: paramBuffer } },
        { binding: 3, resource: { buffer: curveBuffer } },
      ],
    });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(packed.length / 256));
    pass.end();
    encoder.copyBufferToBuffer(output, 0, readback, 0, packed.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const result = new Uint8ClampedArray(readback.getMappedRange().slice(0));
    readback.unmap();
    [input, output, paramBuffer, curveBuffer, readback].forEach((buffer) => buffer.destroy());
    return { data: result, width: payload.width, height: payload.height };
  }
}

const WEBGL_VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 positions[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);
out vec2 uv;
void main() {
  vec2 position = positions[gl_VertexID];
  uv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const WEBGL_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
in vec2 uv;
out vec4 outputColor;
uniform sampler2D sourceTexture;
uniform sampler2D curveTexture;
uniform vec2 imageSize;
uniform float settings[19];

float saturate(float value) { return clamp(value, 0.0, 1.0); }
float curveValue(int channel, float value) {
  vec4 sampleValue = texture(
    curveTexture,
    vec2((floor(saturate(value) * 255.0) + 0.5) / 256.0, 0.5)
  );
  return channel == 0 ? sampleValue.r
    : channel == 1 ? sampleValue.g
    : channel == 2 ? sampleValue.b
    : sampleValue.a;
}
float randomValue(vec2 coordinate, float seed) {
  return fract(sin(dot(coordinate + seed, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}
void main() {
  vec4 source = texture(sourceTexture, uv);
  vec3 color = source.rgb;
  float temperature = settings[2] / 255.0 * 0.55;
  float tint = settings[3] / 255.0;
  color += vec3(temperature + tint * 0.32, tint * -0.42, -temperature + tint * 0.28);
  float light = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float adjusted = saturate(light * exp2(settings[4]));
  float highlightWeight = smoothstep(0.42, 0.96, adjusted);
  float shadowWeight = 1.0 - smoothstep(0.04, 0.58, adjusted);
  float whiteWeight = smoothstep(0.68, 1.0, adjusted);
  float blackWeight = 1.0 - smoothstep(0.0, 0.34, adjusted);
  adjusted += (1.0 - adjusted) * max(settings[6], 0.0) / 100.0 * highlightWeight * 0.52;
  adjusted += adjusted * min(settings[6], 0.0) / 100.0 * highlightWeight * 0.42;
  adjusted += (1.0 - adjusted) * max(settings[7], 0.0) / 100.0 * shadowWeight * 0.42;
  adjusted += adjusted * min(settings[7], 0.0) / 100.0 * shadowWeight * 0.72;
  adjusted += (1.0 - adjusted) * max(settings[8], 0.0) / 100.0 * whiteWeight * 0.72;
  adjusted += adjusted * min(settings[8], 0.0) / 100.0 * whiteWeight * 0.34;
  adjusted += (1.0 - adjusted) * max(settings[9], 0.0) / 100.0 * blackWeight * 0.24;
  adjusted += adjusted * min(settings[9], 0.0) / 100.0 * blackWeight * 0.86;
  color += vec3(adjusted - light);
  light = dot(color, vec3(0.2126, 0.7152, 0.0722));
  float maximum = max(color.r, max(color.g, color.b));
  float minimum = min(color.r, min(color.g, color.b));
  float chroma = maximum > 0.0001 ? (maximum - minimum) / maximum : 0.0;
  float vibrance = settings[11] / 100.0;
  float colorFactor = (1.0 + vibrance * (vibrance > 0.0 ? 1.0 - chroma : 0.82) * 0.9)
    * (1.0 + settings[12] / 100.0);
  color = vec3(light) + (color - vec3(light)) * colorFactor;
  float contrast = settings[5];
  float contrastFactor = (259.0 * (contrast + 255.0)) / (255.0 * (259.0 - contrast));
  color = (color * 255.0 - 128.0) * contrastFactor / 255.0 + 128.0 / 255.0;
  float grainSize = max(1.0, settings[14] * max(imageSize.x, imageSize.y) / 1600.0);
  vec2 grainCell = floor(gl_FragCoord.xy / grainSize);
  float grainWeight = (0.82 + (1.0 - light) * 0.36)
    * (1.0 - smoothstep(0.58, 0.98, light) * (1.0 - settings[17] / 100.0));
  float amplitude = settings[13] * 2.15 * grainWeight / 255.0;
  float coarseNoise = randomValue(grainCell, settings[18]);
  float fineNoise = randomValue(gl_FragCoord.xy, settings[18] + 59.0);
  float roughness = settings[15] / 100.0;
  float baseNoise = (
    coarseNoise * (1.0 - roughness * 0.58)
    + fineNoise * roughness * 0.72
  ) * amplitude;
  float colorAmount = settings[16] / 100.0;
  float redNoise = randomValue(grainCell, settings[18] + 117.0) * amplitude * colorAmount;
  float blueNoise = randomValue(grainCell, settings[18] + 293.0) * amplitude * colorAmount;
  color += vec3(
    baseNoise + redNoise,
    baseNoise - (redNoise + blueNoise) * 0.28,
    baseNoise + blueNoise
  );
  float masterRed = curveValue(0, saturate(color.r));
  float masterGreen = curveValue(0, saturate(color.g));
  float masterBlue = curveValue(0, saturate(color.b));
  outputColor = vec4(
    curveValue(1, masterRed),
    curveValue(2, masterGreen),
    curveValue(3, masterBlue),
    source.a
  );
}`;

class WebGl2BasicRenderer {
  constructor(environment) {
    this.environment = environment;
    this.canvas = null;
    this.gl = null;
    this.program = null;
  }

  compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) || "WebGL shader 编译失败");
    }
    return shader;
  }

  initialize(width, height) {
    if (!this.canvas) {
      this.canvas = typeof this.environment.OffscreenCanvas !== "undefined"
        ? new this.environment.OffscreenCanvas(width, height)
        : this.environment.document.createElement("canvas");
      this.gl = this.canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!this.gl) throw new Error("WebGL 2 不可用");
      const vertex = this.compile(this.gl, this.gl.VERTEX_SHADER, WEBGL_VERTEX_SHADER);
      const fragment = this.compile(this.gl, this.gl.FRAGMENT_SHADER, WEBGL_FRAGMENT_SHADER);
      this.program = this.gl.createProgram();
      this.gl.attachShader(this.program, vertex);
      this.gl.attachShader(this.program, fragment);
      this.gl.linkProgram(this.program);
      if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
        throw new Error(this.gl.getProgramInfoLog(this.program) || "WebGL program 链接失败");
      }
      this.gl.deleteShader(vertex);
      this.gl.deleteShader(fragment);
    }
    this.canvas.width = width;
    this.canvas.height = height;
    return this.gl;
  }

  makeTexture(gl, unit, width, height, data) {
    const texture = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      data,
    );
    return texture;
  }

  async render(payload) {
    if (
      payload.settings.texture
      || payload.settings.clarity
      || payload.settings.dehaze
    ) {
      throw new Error("多尺度细节需要 Worker");
    }
    const gl = this.initialize(payload.width, payload.height);
    const curveData = new Uint8Array(256 * 4);
    ["master", "red", "green", "blue"].forEach((channel, channelIndex) => {
      const lut = smoothCurveLut(payload.curves[channel]);
      for (let code = 0; code < 256; code += 1) {
        curveData[code * 4 + channelIndex] = lut[code];
      }
    });
    const sourceTexture = this.makeTexture(
      gl,
      0,
      payload.width,
      payload.height,
      new Uint8Array(payload.data),
    );
    const curves = this.makeTexture(gl, 1, 256, 1, curveData);
    gl.viewport(0, 0, payload.width, payload.height);
    gl.useProgram(this.program);
    gl.uniform1i(gl.getUniformLocation(this.program, "sourceTexture"), 0);
    gl.uniform1i(gl.getUniformLocation(this.program, "curveTexture"), 1);
    gl.uniform2f(
      gl.getUniformLocation(this.program, "imageSize"),
      payload.width,
      payload.height,
    );
    gl.uniform1fv(gl.getUniformLocation(this.program, "settings[0]"), Float32Array.from([
      payload.width,
      payload.height,
      payload.settings.temperature || 0,
      payload.settings.tint || 0,
      payload.settings.exposure || 0,
      payload.settings.contrast || 0,
      payload.settings.highlights || 0,
      payload.settings.shadows || 0,
      payload.settings.whites || 0,
      payload.settings.blacks || 0,
      payload.settings.dehaze || 0,
      payload.settings.vibrance || 0,
      payload.settings.saturation || 0,
      payload.settings.grain || 0,
      payload.settings.grainSize || 1,
      payload.settings.grainRoughness || 50,
      payload.settings.grainColor || 12,
      payload.settings.grainHighlights || 25,
      payload.settings.grainSeed || 1847,
    ]));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const result = new Uint8ClampedArray(payload.width * payload.height * 4);
    gl.readPixels(
      0,
      0,
      payload.width,
      payload.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      result,
    );
    gl.deleteTexture(sourceTexture);
    gl.deleteTexture(curves);
    return { data: result, width: payload.width, height: payload.height };
  }
}

export function createRenderPipeline(workerClient, environment = globalThis) {
  const preferred = detectRenderBackend(environment);
  const webGpuRenderer = preferred.id === "webgpu" ? new WebGpuBasicRenderer() : null;
  const webGlRenderer = preferred.id === "webgl2"
    ? new WebGl2BasicRenderer(environment)
    : null;
  return {
    preferred,
    async renderBasic(payload, options) {
      if (webGpuRenderer) {
        try {
          const result = await webGpuRenderer.render(payload);
          const histogram = await workerClient.run(
            "histogram",
            { data: new Uint8ClampedArray(result.data) },
            { photoId: `histogram:${options?.photoId || "preview"}` },
          );
          return { ...result, histogram, backend: "webgpu" };
        } catch {
          // The worker path is the compatibility and device-loss fallback.
        }
      }
      if (webGlRenderer) {
        try {
          const result = await webGlRenderer.render(payload);
          const histogram = await workerClient.run(
            "histogram",
            { data: new Uint8ClampedArray(result.data) },
            { photoId: `histogram:${options?.photoId || "preview"}` },
          );
          return { ...result, histogram, backend: "webgl2" };
        } catch {
          // The worker path is the shader-compile and context-loss fallback.
        }
      }
      const result = await workerClient.run("render-basic", payload, options);
      return { ...result, backend: "worker-cpu" };
    },
  };
}
