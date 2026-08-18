import './ui/scss/style.scss';
import { version as pcuiVersion, revision as pcuiRevision } from '@playcanvas/pcui';
import { version as stVersion, revision as stRevision } from '@playcanvas/splat-transform';
import { version as engineVersion, revision as engineRevision } from 'playcanvas';

import { main } from './main';
import { version as appVersion } from '../package.json';

// print out versions of dependent packages
// NOTE: add dummy style reference to prevent tree shaking
console.log(`SuperSplat v${appVersion} | SplatTransform v${stVersion} (${stRevision}) | Engine v${engineVersion} (${engineRevision}) | PCUI v${pcuiVersion} (${pcuiRevision})`);

main().catch((error) => {
    console.error(error);

    const message = document.createElement('div');
    message.id = 'gpu-required-message';
    const title = document.createElement('strong');
    title.textContent = 'WebGPU 启动失败';
    const details = document.createElement('span');
    details.textContent = error?.message ?? String(error);
    message.append(title, details);
    document.body.appendChild(message);
});
