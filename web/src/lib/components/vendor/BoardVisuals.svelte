<script lang="ts">
 import {onMount} from 'svelte';
 import {createRoot} from 'react-dom/client';
 import {createElement} from 'react';
 import BoardVisuals,{type Card} from './BoardVisuals';
 import './boards.css';
 let {cards,mode,labels}:{cards:Card[];mode:string;labels:Record<string,string>}=$props();
 let el:HTMLDivElement;let root=$state<ReturnType<typeof createRoot>|undefined>();
 onMount(()=>{root=createRoot(el);root.render(createElement(BoardVisuals,{cards,mode,labels}));return()=>root?.unmount();});
 $effect(()=>{const props={cards,mode,labels};root?.render(createElement(BoardVisuals,props));});
</script>
<div bind:this={el} class="min-w-0" aria-label="Visual task boards"></div>
