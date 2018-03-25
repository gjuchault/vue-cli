const execa = require('execa')
const terminate = require('terminate')

const channels = require('../channels')
const cwd = require('./cwd')
const folders = require('./folders')
const logs = require('./logs')

const { getCommand } = require('../utils/command')

const MAX_LOGS = 2000

const tasks = new Map()

function getTasks () {
  const file = cwd.get()
  let list = tasks.get(file)
  if (!list) {
    list = []
    tasks.set(file, list)
  }
  return list
}

function list (context) {
  let list = getTasks()
  const file = cwd.get()
  const pkg = folders.readPackage(file, context)
  if (pkg.scripts) {
    const existing = new Map()

    // Get current valid tasks in project `package.json`
    const currentTasks = Object.keys(pkg.scripts).map(
      name => {
        const id = `${file}:${name}`
        existing.set(id, true)
        return {
          id,
          name,
          command: pkg.scripts[name],
          index: list.findIndex(t => t.id === id)
        }
      }
    )

    // Process existing tasks
    const existingTasks = currentTasks.filter(
      task => task.index !== -1
    )
    // Update tasks data
    existingTasks.forEach(task => {
      Object.assign(list[task.index], task)
    })

    // Process new tasks
    const newTasks = currentTasks.filter(
      task => task.index === -1
    ).map(
      task => ({
        ...task,
        status: 'idle',
        child: null,
        logs: []
      })
    )

    // Keep existing or ran tasks
    list = list.filter(
      task => existing.get(task.id) ||
      task.status !== 'idle'
    )

    // Add the new tasks
    list = list.concat(newTasks)

    tasks.set(file, list)
  }
  return list
}

function findOne (id, context) {
  return getTasks().find(
    t => t.id === id
  )
}

function updateOne (data, context) {
  const task = findOne(data.id)
  if (task) {
    Object.assign(task, data)
    context.pubsub.publish(channels.TASK_CHANGED, {
      taskChanged: task
    })
  }
  return task
}

function run (id, context) {
  const task = findOne(id, context)
  if (task && task.status !== 'running') {
    const args = ['run', task.name]

    const child = execa(getCommand(), args, {
      cwd: cwd.get(),
      stdio: ['inherit', 'pipe', 'pipe']
    })

    updateOne({
      id: task.id,
      status: 'running',
      child
    }, context)
    logs.add({
      message: `Task ${task.id} started`,
      type: 'info'
    }, context)

    child.stdout.on('data', buffer => {
      addLog({
        taskId: task.id,
        type: 'stdout',
        text: buffer.toString()
      }, context)
    })

    child.stderr.on('data', buffer => {
      addLog({
        taskId: task.id,
        type: 'stderr',
        text: buffer.toString()
      }, context)
    })

    child.on('close', (code, signal) => {
      if (code === null) {
        updateOne({
          id: task.id,
          status: 'terminated',
          child: null
        }, context)
        logs.add({
          message: `Task ${task.id} was terminated`,
          type: 'warn'
        }, context)
      } else if (code !== 0) {
        updateOne({
          id: task.id,
          status: 'error',
          child: null
        }, context)
        logs.add({
          message: `Task ${task.id} ended with error code ${code}`,
          type: 'error'
        }, context)
      } else {
        updateOne({
          id: task.id,
          status: 'done',
          child: null
        }, context)
        logs.add({
          message: `Task ${task.id} completed`,
          type: 'done'
        }, context)
      }
    })
  }
  return task
}

function stop (id, context) {
  const task = findOne(id, context)
  if (task && task.status === 'running') {
    terminate(task.child.pid)
  }
  return task
}

function addLog (log, context) {
  const task = findOne(log.taskId, context)
  if (task) {
    if (task.logs.length === MAX_LOGS) {
      task.logs.shift()
    }
    task.logs.push(log)
    context.pubsub.publish(channels.TASK_LOG_ADDED, {
      taskLogAdded: log
    })
  }
}

function clearLogs (id, context) {
  const task = findOne(id, context)
  if (task) {
    task.logs = []
  }
  return task
}

module.exports = {
  list,
  findOne,
  run,
  stop,
  updateOne,
  clearLogs
}