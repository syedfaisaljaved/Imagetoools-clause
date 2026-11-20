// Each tool: form schema for the UI + build() that turns form values into ChatGPT steps.
// A step = one prompt in the same conversation; `images` are input keys attached to that message.

const KEEP = 'Keep the exact same product: identical shape, proportions, silhouette, stitching, seams, legs, hardware and every design detail. Do not add, remove or redesign anything.';
const PHOTO = 'Photorealistic professional product photography, soft even studio lighting, natural shadows, sharp focus, high resolution, true-to-life colors.';
const NOW = 'Do not ask any questions — generate the image now.';

const BACKGROUNDS = {
  'White studio': 'on a seamless pure white studio background',
  'Light grey studio': 'on a seamless light grey studio background',
  'Same as original': 'with the same background as the original photo',
  'Modern living room': 'placed in a bright, modern, minimal living room interior',
};

const ANGLES = {
  'Front': 'straight-on front view at eye level',
  'Front 45° left': 'three-quarter view from the front-left at 45 degrees',
  'Front 45° right': 'three-quarter view from the front-right at 45 degrees',
  'Left side': 'full left side profile view',
  'Right side': 'full right side profile view',
  'Back': 'full back view showing the rear of the product',
  'Top-down': 'top-down view from directly above',
  'Detail close-up': 'close-up macro detail shot of the material texture and craftsmanship',
};

const FABRICS = ['Keep original', 'Velvet', 'Linen', 'Boucle', 'Chenille', 'Leather', 'Faux leather', 'Cotton twill', 'Jacquard', 'Corduroy'];
const FINISHES = ['Keep original', 'Walnut', 'Natural oak', 'Teak', 'Dark espresso', 'Matte black', 'White lacquer', 'Brushed gold metal', 'Chrome'];

const extra = (notes) => (notes?.trim() ? ` Additional instructions: ${notes.trim()}` : '');

export const tools = [
  {
    id: 'angles',
    name: 'Multi-angle',
    description: 'One product photo → the same product from many angles.',
    inputs: [{ key: 'product', label: 'Product photo' }],
    fields: [
      { key: 'angles', label: 'Angles', type: 'multi', options: Object.keys(ANGLES), default: ['Front', 'Front 45° left', 'Left side', 'Back'] },
      { key: 'background', label: 'Background', type: 'select', options: Object.keys(BACKGROUNDS), default: 'White studio' },
      { key: 'notes', label: 'Notes (optional)', type: 'text' },
    ],
    build: ({ angles, background, notes }) =>
      angles.map((a, i) => ({
        images: i === 0 ? ['product'] : [],
        prompt: `${i === 0 ? 'This is a product photo.' : 'Same product as before.'} Create a new image of this exact product shown as a ${ANGLES[a]}, ${BACKGROUNDS[background]}. ${KEEP} ${PHOTO}${extra(notes)} ${NOW}`,
      })),
  },
  {
    id: 'fabric',
    name: 'Apply fabric',
    description: 'Furniture photo + fabric photo → furniture upholstered in that fabric.',
    inputs: [
      { key: 'furniture', label: 'Furniture photo' },
      { key: 'fabric', label: 'Fabric photo' },
    ],
    fields: [
      { key: 'area', label: 'Apply to', type: 'select', options: ['All upholstery', 'Seat & back cushions only', 'Cushions/pillows only'], default: 'All upholstery' },
      { key: 'background', label: 'Background', type: 'select', options: Object.keys(BACKGROUNDS), default: 'Same as original' },
      { key: 'notes', label: 'Notes (optional)', type: 'text' },
    ],
    build: ({ area, background, notes }) => [{
      images: ['furniture', 'fabric'],
      prompt: `Image 1 is a piece of furniture. Image 2 is a fabric swatch. Re-upholster the furniture from image 1 using the fabric from image 2, applied to: ${area.toLowerCase()}. Match the fabric's exact color, pattern, scale and texture, wrapping naturally around curves, seams and cushions. ${KEEP} Keep the camera angle, wood/metal parts and finish unchanged, ${BACKGROUNDS[background]}. ${PHOTO}${extra(notes)} ${NOW}`,
    }],
  },
  {
    id: 'restyle',
    name: 'Restyle',
    description: 'Same furniture, new fabric / color / polish.',
    inputs: [{ key: 'furniture', label: 'Furniture photo' }],
    fields: [
      { key: 'fabric', label: 'Fabric', type: 'select', options: FABRICS, default: 'Velvet' },
      { key: 'color', label: 'Fabric color', type: 'text', placeholder: 'e.g. emerald green' },
      { key: 'finish', label: 'Wood / metal polish', type: 'select', options: FINISHES, default: 'Keep original' },
      { key: 'background', label: 'Background', type: 'select', options: Object.keys(BACKGROUNDS), default: 'Same as original' },
      { key: 'notes', label: 'Notes (optional)', type: 'text' },
    ],
    build: ({ fabric, color, finish, background, notes }) => {
      const changes = [
        fabric !== 'Keep original' && `upholstery fabric → ${fabric.toLowerCase()}`,
        color?.trim() && `fabric color → ${color.trim()}`,
        finish !== 'Keep original' && `wood/metal polish → ${finish.toLowerCase()}`,
      ].filter(Boolean);
      return [{
        images: ['furniture'],
        prompt: `Recreate this exact furniture with only these changes: ${changes.join('; ') || 'a fresh premium look'}. ${KEEP} Keep the same camera angle and framing, ${BACKGROUNDS[background]}. ${PHOTO}${extra(notes)} ${NOW}`,
      }];
    },
  },
];

const byId = Object.fromEntries(tools.map((t) => [t.id, t]));

// Validates input, fills defaults and returns the ChatGPT steps. Throws on bad input.
export function buildSteps(toolId, images, options = {}) {
  const tool = byId[toolId];
  if (!tool) throw new Error(`Unknown tool: ${toolId}`);
  for (const { key, label } of tool.inputs) if (!images?.[key]) throw new Error(`Missing image: ${label}`);
  const opts = {};
  for (const f of tool.fields) {
    const v = options[f.key] ?? f.default ?? '';
    if (f.type === 'select' && !f.options.includes(v)) throw new Error(`Invalid ${f.label}`);
    if (f.type === 'multi' && (!Array.isArray(v) || !v.length || v.some((x) => !f.options.includes(x)))) throw new Error(`Pick at least one: ${f.label}`);
    opts[f.key] = f.type === 'text' ? String(v).slice(0, 500) : v;
  }
  return tool.build(opts);
}

// UI-safe view (no functions).
export const toolSchemas = tools.map(({ build, ...t }) => t);
