(() => {
      const duration = 15;
      let currentTime = 8;
      let selectedObject = 'product';
      let selectedName = '香水瓶 B';
      let range = [4, 15];
      let playing = false;
      let playStart = 0;
      let annotationMode = false;
      let dragStart = null;
      let timer = null;

      const $ = (s, root = document) => root.querySelector(s);
      const $$ = (s, root = document) => [...root.querySelectorAll(s)];
      const videoFrame = $('#videoFrame');
      const product = $('.product-object');
      const character = $('.character-object');
      const annotationBox = $('#annotationBox');
      const commandInput = $('#commandInput');
      const planCard = $('#planCard');
      const agentMessage = $('#agentMessage');
      const status = $('#agentStatus');

      const subjectSpecs = {
        product: {
          lifecycle: [4, 15], label: '香水瓶 B', tracks: ['shots', 'product', 'character', 'camera'],
          impacts: [
            ['主状态', '香水瓶 B · 04.0s—15.0s', 'CHANGE', 'change'],
            ['关系', '人物 A 手持 · 04.0s—10.0s', 'RECHECK', 'guard'],
            ['构图', '镜头 03 商品特写', 'REFLOW', 'guard'],
            ['保护', 'Logo、人物身份、音乐', 'LOCK', 'guard']
          ]
        },
        character: {
          lifecycle: [0, 10], label: '人物 A · Mia', tracks: ['shots', 'character', 'product', 'camera'],
          impacts: [
            ['主状态', '人物 A · 00.0s—10.0s', 'CHANGE', 'change'],
            ['关系', '手持商品 B · 04.0s—10.0s', 'RECHECK', 'guard'],
            ['构图', '镜头 01—02 人物占位', 'REFLOW', 'guard'],
            ['保护', '商品、Logo、音乐', 'LOCK', 'guard']
          ]
        },
        logo: {
          lifecycle: [12, 15], label: '品牌文案', tracks: ['shots', 'logo'],
          impacts: [
            ['主状态', '品牌文案 · 12.0s—15.0s', 'CHANGE', 'change'],
            ['构图', '镜头 03 右下安全区', 'REFLOW', 'guard'],
            ['保护', '商品、人物、背景', 'LOCK', 'guard']
          ]
        },
        scene: {
          lifecycle: [0, 15], label: '巴黎夜景', tracks: ['shots', 'character', 'product', 'camera'],
          impacts: [
            ['主状态', '巴黎夜景 · 00.0s—15.0s', 'CHANGE', 'change'],
            ['光照', '人物与商品环境光', 'RECHECK', 'guard'],
            ['构图', '全部镜头透视与边界', 'REFLOW', 'guard'],
            ['保护', '人物、商品、Logo、音乐', 'LOCK', 'guard']
          ]
        },
        annotation: {
          lifecycle: [6, 10], label: '空间标注 #1', tracks: ['shots'],
          impacts: [['局部区域', '空间标注 · 当前镜头', 'CHANGE', 'change'], ['保护', '标注框外全部像素', 'LOCK', 'guard']]
        }
      };
      const harnessOrder = ['BOUND', 'TRACED', 'IMPACTED', 'GUARDED', 'COMPILED', 'COMMITTED'];

      function getSubjectSpec() {
        const spec = subjectSpecs[selectedObject] || subjectSpecs.annotation;
        if (selectedObject === 'annotation') spec.lifecycle = [...range];
        return spec;
      }

      function setHarnessStage(stage) {
        const stageIndex = harnessOrder.indexOf(stage);
        $$('.harness-node').forEach((node, idx) => {
          node.classList.toggle('done', stage === 'COMMITTED' ? idx <= stageIndex : idx < stageIndex);
          node.classList.toggle('active', stage !== 'COMMITTED' && idx === stageIndex);
        });
        $('#harnessState').textContent = stage;
      }

      function updateHarness() {
        const spec = getSubjectSpec();
        const [start, end] = spec.lifecycle;
        $('#lifecycleText').textContent = `${start.toFixed(1)}s — ${end.toFixed(1)}s`;
        $('#lifecycleReadout').textContent = `出现 ${start.toFixed(1)} → 消失 ${end.toFixed(1)}`;
        $('#lifecycleSpan').style.left = `${start / duration * 100}%`;
        $('#lifecycleSpan').style.width = `${(end - start) / duration * 100}%`;
        $('#impactList').innerHTML = spec.impacts.map(([kind, copy, tag, style], idx) => {
          const dynamicCopy = idx === 0 ? `${spec.label} · ${start.toFixed(1)}s—${end.toFixed(1)}s` : copy;
          return `<div class="impact-row"><b>${kind}</b><span>${dynamicCopy}</span><i class="impact-tag ${style}">${tag}</i></div>`;
        }).join('');
        $$('.track-row').forEach(row => {
          const affected = spec.tracks.includes(row.dataset.track);
          row.classList.toggle('dependency', affected);
          const propagation = $('.propagation-range', row);
          if (propagation) {
            propagation.classList.toggle('visible', affected);
            propagation.style.left = `${start / duration * 100}%`;
            propagation.style.width = `${(end - start) / duration * 100}%`;
          }
          $$('.segment', row).forEach(segment => {
            if (!segment.dataset.range) return;
            const [segStart, segEnd] = segment.dataset.range.split(',').map(Number);
            segment.classList.toggle('affected', affected && segStart < end && segEnd > start);
          });
          $$('.semantic-clip', row).forEach(clip => clip.classList.toggle('affected', clip.dataset.entity === selectedObject));
        });
        setHarnessStage('TRACED');
      }

      function formatTime(seconds) {
        return `00:${seconds.toFixed(1).padStart(4, '0')}`;
      }

      function stateFor(object, time) {
        if (object === 'product') return time < 4 ? 'off_screen' : time < 10 ? 'held_by_character_A' : 'hero_packshot';
        if (object === 'character') return time < 4 ? 'walking' : time < 10 ? 'presenting_product' : 'off_screen';
        if (object === 'logo') return time < 12 ? 'hidden' : 'visible';
        if (object === 'scene') return 'paris_night_locked';
        return 'annotated_region';
      }

      function renderAtTime(time) {
        currentTime = Math.max(0, Math.min(duration, time));
        const p = (currentTime / duration) * 100;
        $$('.playhead').forEach(el => el.style.left = `${p}%`);
        $('#timecode').textContent = `${formatTime(currentTime)} / 00:15.0`;
        $('#frameTime').textContent = formatTime(currentTime);
        $('#selectedState').textContent = stateFor(selectedObject, currentTime);

        if (currentTime < 4) {
          product.style.opacity = '.08'; product.style.left = '56%'; product.style.bottom = '21%'; product.style.transform = 'scale(.72)';
          character.style.left = '23%'; character.style.transform = 'scale(.92)';
          $('#shotLabel').textContent = '镜头 01 · 进入夜景';
        } else if (currentTime < 10) {
          product.style.opacity = '1'; product.style.left = '53%'; product.style.bottom = '22%'; product.style.transform = 'scale(.9)';
          character.style.left = '35%'; character.style.transform = 'scale(1)';
          $('#shotLabel').textContent = '镜头 02 · 展示商品';
        } else {
          product.style.opacity = '1'; product.style.left = '64%'; product.style.bottom = '18%'; product.style.transform = 'scale(1.35)';
          character.style.left = '24%'; character.style.transform = 'scale(.86)';
          $('#shotLabel').textContent = '镜头 03 · Hero Packshot';
        }
      }

      function setRange(start, end) {
        range = [start, end];
        const left = (start / duration) * 100;
        const width = ((end - start) / duration) * 100;
        $$('.selection-range').forEach(el => { el.style.left = `${left}%`; el.style.width = `${width}%`; });
        $('#selectedRange').textContent = `${start.toFixed(1)}s — ${end.toFixed(1)}s`;
        $('.selection-readout').textContent = `已选择：${start.toFixed(1)}s—${end.toFixed(1)}s · ${selectedName}`;
      }

      function selectObject(object, name) {
        selectedObject = object;
        selectedName = name;
        $$('.canvas-object').forEach(el => el.classList.toggle('selected', el.dataset.object === object));
        $$('.asset-card, .layer-row').forEach(el => el.classList.toggle('selected', el.dataset.select === object));
        $('#selectedTarget').textContent = name;
        $('#selectedState').textContent = stateFor(object, currentTime);
        $('#contextBadge').textContent = object === 'annotation' ? '空间标注' : '已绑定实体';
        $('.selection-toolbar').classList.add('visible');
        planCard.classList.remove('visible');
        const activeScope = $('.scope-chip.active')?.textContent;
        if (activeScope === '主体生命周期') {
          const [start, end] = getSubjectSpec().lifecycle;
          setRange(start, end);
        }
        updateHarness();
        status.textContent = '主体已绑定';
      }

      $$('.canvas-object').forEach(el => {
        el.addEventListener('click', e => {
          if (annotationMode) return;
          e.stopPropagation();
          const names = { product: '香水瓶 B', character: '人物 A · Mia', logo: '品牌文案' };
          selectObject(el.dataset.object, names[el.dataset.object]);
        });
      });
      $$('[data-select]').forEach(el => el.addEventListener('click', e => {
        if (e.target.closest('.lock-btn')) return;
        const object = el.dataset.select;
        const names = { product: '香水瓶 B', character: '人物 A · Mia', logo: '品牌文案', scene: '巴黎夜景' };
        selectObject(object, names[object]);
      }));

      const sidebarLabels = {
        project: ['Project Context', '剧本与分镜'],
        assets: ['Persistent Library', '长期资产与 @引用'],
        layers: ['Semantic Graph', '主体、图层与锁']
      };

      function activateSidebar(tab) {
        $$('.panel-tabs button').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
        $$('.tab-content').forEach(panel => panel.classList.toggle('active', panel.dataset.panel === tab));
        $('#sidebarEyebrow').textContent = sidebarLabels[tab][0];
        $('#sidebarTitle').textContent = sidebarLabels[tab][1];
      }

      $$('.panel-tabs button').forEach(btn => btn.addEventListener('click', () => activateSidebar(btn.dataset.tab)));
      $('#addAssetBtn').addEventListener('click', () => {
        activateSidebar('assets');
        $('#uploadAssetZone').classList.add('selected');
      });
      $('#uploadAssetZone').addEventListener('click', () => {
        $('#toast').textContent = '资产上传入口：可补充三视图、声音、Logo 与材质参考。';
        $('#toast').classList.add('visible');
        setTimeout(() => $('#toast').classList.remove('visible'), 2400);
      });

      function addReferenceToken(reference) {
        const exists = $$('#activeReferences .reference-token').some(token => token.textContent === reference);
        if (!exists) $('#activeReferences').insertAdjacentHTML('beforeend', `<span class="reference-token">${reference}</span>`);
        if (!commandInput.value.includes(reference)) commandInput.value = `${reference} ${commandInput.value}`.trim();
        $('#referenceMenu').classList.remove('visible');
        status.textContent = `${reference} 已绑定`;
      }

      $$('[data-reference]').forEach(option => option.addEventListener('click', e => {
        if (option.closest('#referenceMenu') || option.classList.contains('asset-ref')) {
          e.stopPropagation();
          addReferenceToken(option.dataset.reference);
        }
      }));
      $('#referenceBtn').addEventListener('click', e => {
        e.stopPropagation();
        $('#referenceMenu').classList.toggle('visible');
      });
      document.addEventListener('click', () => $('#referenceMenu').classList.remove('visible'));

      $$('.lock-btn').forEach(btn => btn.addEventListener('click', e => {
        e.stopPropagation();
        btn.classList.toggle('locked');
        btn.textContent = btn.classList.contains('locked') ? '▣' : '□';
        const lock = btn.dataset.lock;
        const chip = [...$('#lockList').children].find(x => x.textContent.includes(lock));
        if (btn.classList.contains('locked') && !chip) $('#lockList').insertAdjacentHTML('beforeend', `<span class="lock-chip">${lock}</span>`);
        if (!btn.classList.contains('locked') && chip) chip.remove();
      }));

      $$('.scope-chip').forEach(btn => btn.addEventListener('click', () => {
        $$('.scope-chip').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        $('#selectedScope').textContent = btn.textContent;
        if (btn.textContent === '此刻') setRange(Math.max(0, currentTime - .25), Math.min(duration, currentTime + .25));
        if (btn.textContent === '本镜头') setRange(currentTime < 4 ? 0 : currentTime < 10 ? 4 : 10, currentTime < 4 ? 4 : currentTime < 10 ? 10 : 15);
        if (btn.textContent === '主体生命周期') setRange(...getSubjectSpec().lifecycle);
        if (btn.textContent === '从这里开始') setRange(currentTime, duration);
        if (btn.textContent === '全片') setRange(0, duration);
        updateHarness();
      }));

      $$('.segment[data-range]').forEach(seg => seg.addEventListener('click', () => {
        const [start, end] = seg.dataset.range.split(',').map(Number);
        setRange(start, end); renderAtTime((start + end) / 2);
      }));

      const referenceByEntity = { character: '@Mia', product: '@Nocturne_Bottle', logo: '@Nocturne_Bottle' };
      function updateLifecycleClip(clip, start, end) {
        const entity = clip.dataset.entity;
        clip.dataset.start = start;
        clip.dataset.end = end;
        clip.style.left = `${start / duration * 100}%`;
        clip.style.width = `${(end - start) / duration * 100}%`;
        $('.entry-label', clip).textContent = `进场 ${start.toFixed(1)}s`;
        $('.exit-label', clip).textContent = `出场 ${end.toFixed(1)}s`;
        subjectSpecs[entity].lifecycle = [start, end];
        const layerCopy = $(`.asset-card[data-select="${entity}"] .asset-copy span`);
        if (layerCopy) layerCopy.textContent = `${start.toFixed(1)}s—${end.toFixed(1)}s · ${referenceByEntity[entity] || ''}`;
        if (selectedObject === entity) {
          if ($('.scope-chip.active')?.textContent === '主体生命周期') setRange(start, end);
          updateHarness();
        }
      }

      $$('.semantic-clip').forEach(clip => clip.addEventListener('pointerdown', e => {
        const entity = clip.dataset.entity;
        const names = { product: '香水瓶 B', character: '人物 A · Mia', logo: '品牌文案' };
        selectObject(entity, names[entity]);
        const canvas = clip.parentElement;
        const rect = canvas.getBoundingClientRect();
        const originX = e.clientX;
        const originalStart = Number(clip.dataset.start);
        const originalEnd = Number(clip.dataset.end);
        const span = originalEnd - originalStart;
        const edge = e.target.closest('.edge-handle')?.dataset.edge || 'move';
        clip.classList.add('dragging');
        clip.setPointerCapture(e.pointerId);

        const move = ev => {
          const delta = Math.round(((ev.clientX - originX) / rect.width * duration) * 2) / 2;
          let start = originalStart;
          let end = originalEnd;
          if (edge === 'start') start = Math.max(0, Math.min(originalEnd - .5, originalStart + delta));
          if (edge === 'end') end = Math.min(duration, Math.max(originalStart + .5, originalEnd + delta));
          if (edge === 'move') {
            start = Math.max(0, Math.min(duration - span, originalStart + delta));
            end = start + span;
          }
          updateLifecycleClip(clip, start, end);
          status.textContent = edge === 'move' ? '正在移动简单轨迹' : edge === 'start' ? '正在调整进场' : '正在调整出场';
        };
        const up = ev => {
          clip.releasePointerCapture(ev.pointerId);
          clip.removeEventListener('pointermove', move);
          clip.removeEventListener('pointerup', up);
          clip.classList.remove('dragging');
          setHarnessStage('IMPACTED');
          status.textContent = '生命周期已重算';
          $('#toast').textContent = `${names[entity]} 的进出场已更新，关联时间线等待重新编译。`;
          $('#toast').classList.add('visible');
          setTimeout(() => $('#toast').classList.remove('visible'), 2200);
        };
        clip.addEventListener('pointermove', move);
        clip.addEventListener('pointerup', up);
        e.preventDefault();
      }));

      $('#aiMotionBtn').addEventListener('click', () => {
        const reference = referenceByEntity[selectedObject] || '';
        commandInput.value = `${reference} 为${selectedName}重新生成一条大幅运动轨迹，保持其他主体和音乐不变`.trim();
        planCard.classList.remove('visible');
        status.textContent = '大幅轨迹指令待编译';
      });

      $$('.transcript-chip').forEach(chip => chip.addEventListener('click', () => {
        $$('.transcript-chip').forEach(c => c.classList.remove('active')); chip.classList.add('active');
        renderAtTime(Number(chip.dataset.time));
      }));

      function scrub(e) {
        const canvas = $('#rulerCanvas');
        const rect = canvas.getBoundingClientRect();
        renderAtTime(((e.clientX - rect.left) / rect.width) * duration);
      }
      $('.timeline-overlay').addEventListener('pointerdown', e => {
        scrub(e); e.currentTarget.setPointerCapture(e.pointerId);
        const move = ev => scrub(ev);
        const up = ev => { e.currentTarget.releasePointerCapture(ev.pointerId); e.currentTarget.removeEventListener('pointermove', move); e.currentTarget.removeEventListener('pointerup', up); };
        e.currentTarget.addEventListener('pointermove', move); e.currentTarget.addEventListener('pointerup', up);
      });

      $('#playBtn').addEventListener('click', () => {
        playing = !playing;
        $('#playBtn').textContent = playing ? '❚❚' : '▶';
        if (!playing) { cancelAnimationFrame(timer); return; }
        playStart = performance.now() - currentTime * 1000;
        const loop = now => {
          if (!playing) return;
          const t = (now - playStart) / 1000;
          if (t >= duration) { playing = false; $('#playBtn').textContent = '▶'; renderAtTime(0); return; }
          renderAtTime(t); timer = requestAnimationFrame(loop);
        };
        timer = requestAnimationFrame(loop);
      });

      $('#annotateTool').addEventListener('click', () => {
        annotationMode = !annotationMode;
        $('#annotateTool').classList.toggle('active', annotationMode);
        $('#selectTool').classList.toggle('active', !annotationMode);
        videoFrame.style.cursor = annotationMode ? 'crosshair' : 'default';
      });
      $('#selectTool').addEventListener('click', () => {
        annotationMode = false; $('#annotateTool').classList.remove('active'); $('#selectTool').classList.add('active'); videoFrame.style.cursor = 'default';
      });
      $('[data-action="annotate"]').addEventListener('click', () => $('#annotateTool').click());
      $('[data-action="lock"]').addEventListener('click', () => {
        const relevant = $(`.asset-card[data-select="${selectedObject}"] .lock-btn`);
        if (relevant) relevant.click();
      });

      videoFrame.addEventListener('pointerdown', e => {
        if (!annotationMode) return;
        const rect = videoFrame.getBoundingClientRect();
        dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        annotationBox.style.display = 'block';
        annotationBox.style.left = `${dragStart.x}px`; annotationBox.style.top = `${dragStart.y}px`;
        annotationBox.style.width = '1px'; annotationBox.style.height = '1px';
        videoFrame.setPointerCapture(e.pointerId);
      });
      videoFrame.addEventListener('pointermove', e => {
        if (!dragStart) return;
        const rect = videoFrame.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        annotationBox.style.left = `${Math.min(x, dragStart.x)}px`; annotationBox.style.top = `${Math.min(y, dragStart.y)}px`;
        annotationBox.style.width = `${Math.abs(x - dragStart.x)}px`; annotationBox.style.height = `${Math.abs(y - dragStart.y)}px`;
      });
      videoFrame.addEventListener('pointerup', e => {
        if (!dragStart) return;
        dragStart = null; videoFrame.releasePointerCapture(e.pointerId);
        selectObject('annotation', '空间标注 #1');
        $('#selectedState').textContent = 'region_annotation';
        annotationMode = false; $('#annotateTool').classList.remove('active'); $('#selectTool').classList.add('active'); videoFrame.style.cursor = 'default';
      });

      function selectScope(label) {
        $$('.scope-chip').forEach(chip => chip.classList.toggle('active', chip.textContent === label));
        $('#selectedScope').textContent = label;
      }

      function compileIntent() {
        const input = commandInput.value;
        const spec = getSubjectSpec();
        let effectiveRange = [...range];
        let before = `${selectedObject}.appearance: current`;
        let after = `${selectedObject}.appearance: requested_variant`;
        let operation = 'update_subject_state';

        if (/第一次出现到消失|同一个商品|生命期|全程/.test(input)) {
          effectiveRange = [...spec.lifecycle];
          selectScope('主体生命周期');
        } else if (/第?8秒|8秒/.test(input)) {
          effectiveRange = [8, spec.lifecycle[1]];
          selectScope('从这里开始');
        }
        if (/大幅.*轨迹|重新生成.*轨迹/.test(input)) {
          effectiveRange = [...spec.lifecycle];
          before = `${selectedObject}.motion_path: simple_manual`;
          after = `${selectedObject}.motion_path: ai_generated`;
          operation = 'regenerate_motion_path';
        } else if (/提前2秒/.test(input)) {
          effectiveRange = [Math.max(0, spec.lifecycle[0] - 2), spec.lifecycle[1]];
          before = 'event.product_first_visible: 04.0s';
          after = 'event.product_first_visible: 02.0s';
          operation = 'retime_subject_lifecycle';
        } else if (/蓝/.test(input)) {
          before = `${selectedObject}.appearance.color: violet`;
          after = `${selectedObject}.appearance.color: deep_blue`;
          operation = 'set_subject_property';
        } else if (/银|替换/.test(input)) {
          before = `${selectedObject}.appearance.variant: glass_violet`;
          after = `${selectedObject}.appearance.variant: matte_silver`;
          operation = 'replace_subject_variant';
        } else if (/特写/.test(input)) {
          before = 'camera.framing: medium_close_up';
          after = 'camera.framing: product_close_up';
          operation = 'reframe_subject';
        }

        setRange(...effectiveRange);
        const propagate = spec.impacts.filter(row => row[2] !== 'LOCK').map(row => row[0]).join(', ');
        return {
          operation,
          effectiveRange,
          propagate,
          html: `<span class="minus">- ${before}</span>\n<span class="plus">+ ${after}</span>\n  lifetime: ${effectiveRange[0].toFixed(1)}s → ${effectiveRange[1].toFixed(1)}s\n  references: ${$$('#activeReferences .reference-token').map(x => x.textContent).join(', ') || 'none'}\n  propagate: ${propagate}\n  preserve: ${$$('#lockList .lock-chip').map(x => x.textContent.trim()).join(', ') || 'none'}\n  transaction: atomic · reversible`
        };
      }

      $$('.quick-prompts button').forEach(btn => btn.addEventListener('click', () => {
        commandInput.value = btn.dataset.prompt;
        planCard.classList.remove('visible');
        setHarnessStage('TRACED');
        status.textContent = '指令已更新';
      }));
      $('#micBtn').addEventListener('click', () => {
        $('#micBtn').textContent = '◍'; status.textContent = '正在聆听';
        setTimeout(() => { $('#micBtn').textContent = '◉'; status.textContent = '已转写'; commandInput.value = '从第8秒开始让商品变成蓝色，但Logo、人物和音乐都不要改变'; }, 900);
      });
      $('#planBtn').addEventListener('click', () => {
        const scope = $('#selectedScope').textContent;
        const spec = getSubjectSpec();
        const intent = compileIntent();
        $('#planTarget').textContent = `${selectedName} · ${spec.lifecycle[0].toFixed(1)}s出现 → ${spec.lifecycle[1].toFixed(1)}s消失 · ${scope}`;
        $('#planImpact').textContent = `${intent.propagate} · 有效范围 ${intent.effectiveRange[0].toFixed(1)}s—${intent.effectiveRange[1].toFixed(1)}s`;
        const lockNames = $$('#lockList .lock-chip').map(x => x.textContent.trim()).join('、') || '无硬锁';
        $('#planLocks').textContent = `保持：${lockNames}；其余属性允许最小变化`;
        $('#patchPreview').innerHTML = intent.html;
        $('#impactEstimate').textContent = `影响：${spec.tracks.length}条时间线 · ${spec.impacts.length}组依赖`;
        planCard.classList.add('visible');
        status.textContent = '正在编译传播关系';
        setHarnessStage('IMPACTED');
        setTimeout(() => setHarnessStage('GUARDED'), 280);
        setTimeout(() => { setHarnessStage('COMPILED'); status.textContent = '级联 Patch 待确认'; }, 560);
        planCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      $('#executeBtn').addEventListener('click', () => {
        agentMessage.classList.add('visible');
        status.textContent = '正在执行主体事务';
        $$('.log').forEach(x => x.classList.remove('done'));
        [0, 1, 2, 3].forEach((idx) => setTimeout(() => {
          $(`[data-log="${idx}"]`).classList.add('done');
          if (idx === 3) {
            status.textContent = '主体事务已提交';
            setHarnessStage('COMMITTED');
            product.classList.toggle('blue', /蓝/.test(commandInput.value));
            product.classList.toggle('silver', /银|替换/.test(commandInput.value));
            const variant = /蓝/.test(commandInput.value) ? 'deep_blue' : /银|替换/.test(commandInput.value) ? 'matte_silver' : 'updated';
            $('#selectedState').textContent = `${stateFor(selectedObject, currentTime)} · ${variant}`;
            $('#toast').textContent = '主体生命周期已重算，级联 Patch 已提交到 Video Spec。';
            $('#toast').classList.add('visible');
            setTimeout(() => $('#toast').classList.remove('visible'), 2400);
          }
        }, 500 + idx * 700));
      });

      renderAtTime(currentTime);
      setRange(range[0], range[1]);
      updateHarness();
    })();
