import { createParticleEditor } from '../src/index'

// Deliberately empty: effects and textures belong to the consuming project.
const editor = createParticleEditor(document.querySelector<HTMLElement>('#editor')!)
void editor.ready.catch(console.error)
window.addEventListener('pagehide', () => editor.destroy(), { once: true })
