<script setup lang="ts">
import { onMounted, ref } from 'vue'
import Icon from '@/components/ui/Icon.vue'
import IconButton from '@/components/ui/IconButton.vue'
import { aiApi } from '@/api/ai'
import type { AiMemoryFact, AiMemorySummary } from '@nenochat/shared'

const props = defineProps<{ conversationId: string; mobile?: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const summaries = ref<AiMemorySummary[]>([])
const facts = ref<AiMemoryFact[]>([])
const loading = ref(true)
const error = ref<string | null>(null)

async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    const result = await aiApi.memory(props.conversationId)
    summaries.value = result.summaries
    facts.value = result.facts
  } catch (e) {
    error.value = e instanceof Error ? e.message : '读取记忆失败'
  } finally {
    loading.value = false
  }
}

async function removeFact(id: string): Promise<void> {
  await aiApi.deleteFact(props.conversationId, id)
  facts.value = facts.value.filter((f) => f.id !== id)
}

onMounted(() => {
  void load()
})
</script>

<template>
  <aside
    class="flex flex-col bg-surface-2"
    :class="props.mobile ? 'w-full' : 'w-[280px] shrink-0 border-l border-line'"
  >
    <header
      class="flex items-center gap-1.5 border-b border-line px-3 py-3"
      :class="props.mobile ? 'pt-[calc(0.75rem+var(--safe-top))]' : ''"
    >
      <Icon name="memory" :size="15" class="text-mention" />
      <h2 class="text-[12.5px] font-medium text-text">AI 记忆</h2>
      <span class="ml-auto" />
      <IconButton icon="refresh" label="刷新" :size="14" @click="load" />
      <IconButton icon="close" label="关闭" :size="14" @click="emit('close')" />
    </header>

    <div class="scroll-area flex-1 px-3 py-3 pb-[calc(0.75rem+var(--safe-bottom))]">
      <p v-if="loading" class="text-[12px] text-muted">读取中…</p>
      <p v-else-if="error" class="text-[12px] text-danger">{{ error }}</p>

      <template v-else>
        <section class="mb-4">
          <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted">会话摘要</h3>
          <p v-if="summaries.length === 0" class="text-[12px] text-muted">
            还没有生成摘要，聊得多一些会自动压缩。
          </p>
          <div
            v-for="summary in summaries"
            :key="summary.id"
            class="mb-1.5 rounded-lg bg-surface p-2 text-[12px] leading-[1.55] text-text"
          >
            {{ summary.summary }}
          </div>
        </section>

        <section>
          <h3 class="mb-1.5 text-[11px] font-medium tracking-wide text-muted">
            记住的事实（{{ facts.length }}）
          </h3>
          <p v-if="facts.length === 0" class="text-[12px] text-muted">
            还没有提取到事实记忆。
          </p>
          <div
            v-for="fact in facts"
            :key="fact.id"
            class="group mb-1 flex items-start gap-1 rounded-lg bg-surface px-2 py-1.5"
          >
            <div class="min-w-0 flex-1">
              <p class="text-[11px] text-muted">{{ fact.subject }} · {{ fact.key }}</p>
              <p class="text-[12px] text-text">{{ fact.value }}</p>
            </div>
            <button
              type="button"
              class="hidden text-muted group-hover:block hover:text-danger"
              title="忘记这条"
              @click="removeFact(fact.id)"
            >
              <Icon name="close" :size="12" />
            </button>
          </div>
        </section>
      </template>
    </div>
  </aside>
</template>
