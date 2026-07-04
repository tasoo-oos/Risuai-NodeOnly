<script lang="ts">
  import { DBState } from 'src/ts/stores.svelte'
  import Check from "src/lib/UI/GUI/CheckInput.svelte"
  import Accordion from 'src/lib/UI/Accordion.svelte'
  import { language } from 'src/lang'
  import ModelList from 'src/lib/UI/ModelList.svelte'
</script>

<div class="flex items-center mt-4">
  <Check bind:check={DBState.db.seperateModelsForAxModels} name={language.seperateModelsForAxModels}></Check>
</div>
{#if DBState.db.seperateModelsForAxModels}
  <Accordion name={language.axModelsDef} styled>
    <span class="text-textcolor mt-4">{language.axModelMemory}</span>
    <ModelList bind:value={DBState.db.seperateModels.memory} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelTranslate}</span>
    <ModelList bind:value={DBState.db.seperateModels.translate} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelEmotion}</span>

    <ModelList bind:value={DBState.db.seperateModels.emotion} blankable blankLabel={language.useDefaultSubModel} />

    <span class="text-textcolor mt-4">{language.axModelOther}</span>

    <ModelList bind:value={DBState.db.seperateModels.otherAx} blankable blankLabel={language.useDefaultSubModel} />
  </Accordion>
{/if}
