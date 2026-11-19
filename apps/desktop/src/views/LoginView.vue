<script setup lang="ts">
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import LoginForm from '@/components/auth/LoginForm.vue'
import { useServersStore } from '@/stores/servers'

const router = useRouter()
const servers = useServersStore()

onMounted(() => {
  if (!servers.current) void router.replace('/setup')
})
</script>

<template>
  <div class="mx-auto max-w-md">
    <LoginForm :show-server-switch="true" @change-server="router.replace('/setup')" />
  </div>
</template>
